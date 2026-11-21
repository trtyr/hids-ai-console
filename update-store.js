import { createCipheriv, createDecipheriv, createHash, randomBytes, sign, verify } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordFailure } from './src/shared/redaction.js';

export const PACKAGE_LIMIT = 2 * 1024 * 1024;
const FORMAT = 'hids-prompts/v1';
const moduleNames = ['告警研判', '深度溯源', '知识经验'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const textValue = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0');
const signatureBody = envelope => JSON.stringify({ format: envelope.format, iv: envelope.iv,
  tag: envelope.tag, ciphertext: envelope.ciphertext });
const bytes = (value, length) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail('升级包编码不正确');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value || (length && buffer.length !== length)) throw fail('升级包编码不正确');
  return buffer;
};

export function publicRelease(value) {
  return { version: value.version, title: value.title, summary: value.summary || '', date: value.date,
    modules: moduleNames, changes: Object.fromEntries(['features', 'improvements', 'fixes']
      .map(key => [key, Array.isArray(value.changes?.[key]) ? value.changes[key] : []])),
    updated_at: value.updated_at || null, sequence: value.sequence || 0,
    // P003-T062：应用人（actor）从存储到接口全程可见——谁应用了这版升级包，概览、历史与审计三处一致。
    actor: value.actor || null,
    id: value.id, filename: value.filename, uploaded_at: value.uploaded_at || null };
}

export function sealPackage(payload, { encryptionKey, privateKey }) {
  if (encryptionKey?.length !== 32) throw fail('策略包加密密钥必须为 32 字节');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope = { format: FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') };
  envelope.signature = sign(null, Buffer.from(signatureBody(envelope)), privateKey).toString('base64');
  return Buffer.from(JSON.stringify(envelope));
}

export function openPackage(buffer, { encryptionKey, publicKey }) {
  if (!Buffer.isBuffer(buffer) || buffer.length > PACKAGE_LIMIT) throw fail('升级包超过 2 MB', 413);
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw fail('升级包格式不正确，仅接受签名加密的 .hids-policy 文件'); }
  if (!object(envelope) || envelope.format !== FORMAT ||
    Object.keys(envelope).sort().join() !== ['ciphertext','format','iv','signature','tag'].sort().join())
    throw fail('升级包类型不正确');
  if (!encryptionKey || !publicKey) throw fail('维护端尚未配置升级包密钥', 503);
  const signature = bytes(envelope.signature, 64);
  if (!verify(null, Buffer.from(signatureBody(envelope)), publicKey, signature)) throw fail('升级包签名校验失败');
  const iv = bytes(envelope.iv, 12), tag = bytes(envelope.tag, 16), ciphertext = bytes(envelope.ciphertext);
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(Buffer.from(FORMAT));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch { throw fail('升级包解密失败或内容无效'); }
}

export class UpdateStore {
  constructor(prompts, { directory = path.join(path.dirname(prompts.filename), 'update-packages'),
    encryptionKey = null, publicKey = null, target = null } = {}) {
    this.prompts = prompts;
    this.directory = directory;
    this.keys = { encryptionKey, publicKey };
    this.target = target;
  }

  get configured() { return Boolean(this.keys.encryptionKey?.length === 32 && this.keys.publicKey && this.target); }

  async validate(payload) {
    if (!object(payload) || payload.type !== 'hids-prompts' || payload.api_version !== 1)
      throw fail('升级包类型或应用接口版本不兼容');
    if (payload.target !== this.target) throw fail('升级包不适用于当前客户环境');
    if (!textValue(payload.version, 80) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(payload.version) ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 1)
      throw fail('升级包版本不正确');
    if (!textValue(payload.title, 120) || !textValue(payload.summary, 600) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '') ||
      Number.isNaN(Date.parse(payload.date)) || new Date(payload.date).toISOString().slice(0, 10) !== payload.date)
      throw fail('升级包公开说明不完整');
    if (!object(payload.changes) || ['features','improvements','fixes'].some(key =>
      !Array.isArray(payload.changes[key]) || payload.changes[key].length > 20 ||
      payload.changes[key].some(item => !textValue(item, 1500))))
      throw fail('升级包更新日志格式不正确');
    const snapshot = await this.prompts.snapshot();
    const keys = Object.keys(snapshot.sections);
    if (!object(payload.sections) || Object.keys(payload.sections).length !== keys.length ||
      keys.some(key => !textValue(payload.sections[key], 20000)))
      throw fail('升级包缺少完整提示词章节或章节格式不正确');
    if (payload.knowledge_revision !== snapshot.knowledge_revision)
      throw fail('升级包与当前知识库版本不兼容', 409);
    const overrides = await this.prompts.readOverrides();
    if ((overrides._history || []).some(item => item.version === payload.version)) throw fail('该版本已应用，不允许使用相同版本号覆盖', 409);
    if (payload.sequence <= (overrides._release?.sequence || 0))
      throw fail('不允许重复应用或降级到旧版本', 409);
    return payload;
  }

  async overview() {
    const [active, overrides] = await Promise.all([this.prompts.load(), this.prompts.readOverrides()]);
    const installed = overrides._release || { version: active.version, title: '初始研判策略',
      summary: '随当前应用安装的研判策略', modules: moduleNames, changes: {}, updated_at: null };
    const history = (overrides._history?.length ? overrides._history : [installed]).slice().reverse()
      .map(item => ({ ...publicRelease(item), current: item.version === active.version, applied: true }));
    return { revision: active.revision, current: publicRelease(installed), history,
      modules: moduleNames.map((name, index) => ({ id: ['triage','trace','knowledge'][index], name,
        version: active.version, description: ['基础策略与场景研判','单告警深查与溯源白板','客户经验核对与维护'][index] })) };
  }

  async stage(buffer, filename) {
    if (!this.configured) throw fail('维护端尚未配置升级包密钥和环境标识', 503);
    if (!textValue(filename, 180) || !/^[^/\\\x00-\x1f]+\.hids-policy$/i.test(filename))
      throw fail('请选择 .hids-policy 加密策略包');
    const payload = await this.validate(openPackage(buffer, this.keys));
    const id = createHash('sha256').update(buffer).digest('hex');
    const uploaded = { id, filename, uploaded_at: new Date().toISOString() };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(this.directory, id + '.json'),
      JSON.stringify({ ...uploaded, envelope: buffer.toString('base64') }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    return this.detail(id);
  }

  async read(id) {
    if (!/^[0-9a-f]{64}$/.test(id || '')) throw fail('升级包 ID 无效', 404);
    try {
      const stored = JSON.parse(await readFile(path.join(this.directory, id + '.json'), 'utf8'));
      const buffer = Buffer.from(stored.envelope, 'base64');
      if (createHash('sha256').update(buffer).digest('hex') !== id) throw fail('已保存的升级包完整性校验失败');
      return { stored, payload: openPackage(buffer, this.keys) };
    } catch (cause) { if (cause.code === 'ENOENT') throw fail('升级包不存在', 404); throw cause; }
  }

  async detail(id) {
    const { stored, payload } = await this.read(id);
    const overrides = await this.prompts.readOverrides();
    const applied = (overrides._history || []).some(item => item.id === id);
    let compatible = true, compatibilityReason = '';
    try { if (!applied) await this.validate(payload); }
    catch (cause) {
      compatible = false;
      // 接口侧不写错误原文（P003-T054）：本模块自己造的提示全过 `fail()`（带 status），原样留给运维看；
      // 上游 / fs / 解析错误的 message 可能带路径或包内容片段，只留固定文案 + 字符量。
      compatibilityReason = cause.status ? cause.message : recordFailure(cause);
    }
    return { ...publicRelease(payload), id, filename: stored.filename, uploaded_at: stored.uploaded_at,
      current: overrides._release?.id === id, applied, compatible, compatibility_reason: compatibilityReason };
  }

  async list() {
    let names;
    try { names = await readdir(this.directory); }
    catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const rows = await Promise.all(names.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(name => this.detail(name.slice(0,-5))));
    return rows.sort((a,b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }

  async apply(id, expectedRevision, actor) {
    if (!this.configured) throw fail('维护端尚未配置升级包密钥和环境标识', 503);
    const { stored, payload } = await this.read(id);
    await this.validate(payload);
    const release = { ...publicRelease(payload), id, filename: stored.filename,
      uploaded_at: stored.uploaded_at, updated_at: new Date().toISOString(), actor };
    await this.prompts.install(payload.sections, release, expectedRevision, payload.knowledge_revision);
    return { id, version: payload.version, updated_at: release.updated_at };
  }
}
