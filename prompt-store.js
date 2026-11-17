import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaults = path.dirname(fileURLToPath(import.meta.url));
const promptDir = path.join(defaults, 'prompts');
const sopDir = path.join(promptDir, 'sop');
const wikiDir = process.env.HIDS_WIKI_DIR || path.join(defaults, 'wiki');
const wikiSop = {
  webshell: 'webshell/WS-13.md', memory_webshell: 'memwebshell/MW-08.md', memory_security: 'rasp/RP-09.md',
  revshell: 'revshell/RS-09.md', suspicious_operation: 'suspicious-command/SC-15.md',
  command_session: 'cmdaudit/CA-08.md', malware: 'malware/MA-09.md', brute_force: 'bruteforce/BF-10.md',
  honeypot: 'honeypot/HP-10.md', elevation_process: 'elevation/LP-10.md',
  abnormal_login: 'abnormal-login/AL-11.md', network_audit: 'net/NA-09.md'
};
const defaultOverrideFile = process.env.HIDS_PROMPT_STORE_FILE || path.join(defaults, '.data', 'prompt-overrides.json');
const coreFiles = { triage: 'triage.md', deep: 'deep-investigation.md', trace: 'trace-board.md', knowledge: 'knowledge-maintenance.md', knowledge_reuse: 'knowledge-reuse.md', cross: 'cross-scenario.md' };
const coreNames = { triage: '通用系统提示词', deep: '单告警深查', trace: '溯源白板', knowledge: '知识库维护', knowledge_reuse: '知识经验复用', cross: '跨场景关联' };

function revisionOf(prompts) {
  return createHash('sha256').update(JSON.stringify(prompts)).digest('hex').slice(0, 16);
}

export class PromptStore {
  constructor(filename = defaultOverrideFile) { this.filename = filename; this.pending = Promise.resolve(); }

  async readOverrides() {
    try { return JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async load() {
    const [parts, scenarioText, overrides] = await Promise.all([
      Promise.all(Object.values(coreFiles).map(name => readFile(path.join(promptDir, name), 'utf8'))),
      readFile(path.join(promptDir, 'scenarios.json'), 'utf8'), this.readOverrides()
    ]);
    const prompts = Object.fromEntries(Object.keys(coreFiles).map((key, index) => [key, overrides[key] ?? parts[index]]));
    const scenarios = JSON.parse(scenarioText);
    for (const card of scenarios.cards) card.prompt = overrides[`scenario:${card.id}`] ?? card.prompt;
    const sop = Object.fromEntries(await Promise.all(['common', ...scenarios.cards.map(card => card.id)].map(async id =>
      [id, await readFile(id === 'common' || id === 'command_whitelist'
        ? path.join(sopDir, `${id}.md`) : path.join(wikiDir, wikiSop[id]), 'utf8')])));
    for (const id of ['common', 'command_whitelist']) sop[id] = overrides[`sop:${id}`] ?? sop[id];
    const revision = revisionOf({ prompts, scenarios, sop, release: overrides._release?.version || null });
    return { version: overrides._release?.version || scenarios.version, revision,
      source: '用户提供的 HIDS 提示词、本项目现有策略与 2026-11-09 核查版场景判据已合并', prompts, scenarios, sop };
  }

  async snapshot() {
    const active = await this.load();
    return {
      sections: { ...active.prompts,
        ...Object.fromEntries(active.scenarios.cards.map(card => [`scenario:${card.id}`, card.prompt])),
        'sop:common': active.sop.common, 'sop:command_whitelist': active.sop.command_whitelist },
      knowledge_revision: revisionOf(Object.fromEntries(Object.entries(active.sop)
        .filter(([id]) => !['common', 'command_whitelist'].includes(id))))
    };
  }

  async install(sections, release, expectedRevision, knowledgeRevision) {
    const job = this.pending.then(async () => {
      const current = await this.load();
      const snapshot = await this.snapshot();
      if (current.revision !== expectedRevision) throw Object.assign(new Error('当前版本已变化，请刷新后重新确认替换'), { status: 409 });
      if (snapshot.knowledge_revision !== knowledgeRevision) throw Object.assign(new Error('升级包与当前知识库版本不兼容'), { status: 409 });
      const keys = Object.keys(snapshot.sections);
      if (!sections || Object.keys(sections).length !== keys.length || keys.some(key =>
        typeof sections[key] !== 'string' || !sections[key].trim() || sections[key].length > 20000 || sections[key].includes('\0')))
        throw Object.assign(new Error('升级包缺少必需章节或正文格式不正确'), { status: 400 });
      const old = await this.readOverrides();
      if (release.sequence <= (old._release?.sequence || 0))
        throw Object.assign(new Error('不允许重复应用或降级到旧版本'), { status: 409 });
      const initial = { version: current.version, title: '初始研判策略', summary: '随当前应用安装的研判策略',
        date: '2026-11-06', modules: ['告警研判', '深度溯源', '知识经验'], changes: {}, updated_at: null };
      const updated = { ...sections, _release: release,
        _history: [...(old._history?.length ? old._history : [initial]), release] };
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(updated), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filename);
      return this.load();
    });
    this.pending = job.catch(() => {});
    return job;
  }

  async metadata() {
    const active = await this.load();
    return { version: active.version, revision: active.revision,
      sections: [
        ...Object.entries(active.prompts).map(([id, content]) => ({ id, name: coreNames[id], kind: 'core', characters: content.length })),
        ...active.scenarios.cards.map(card => ({ id: `scenario:${card.id}`, name: card.name, kind: 'scenario', characters: card.prompt.length })),
        ...Object.entries(active.sop).map(([id, content]) => ({ id: `sop:${id}`, name: id === 'common' ? '通用 SOP' :
          active.scenarios.cards.find(card => card.id === id)?.name || id, kind: 'sop', characters: content.length,
          read_only: true }))
      ] };
  }

  async update(section, content, expectedRevision) {
    const job = this.pending.then(async () => {
      const current = await this.load();
      const allowed = new Set([...Object.keys(coreFiles), ...current.scenarios.cards.map(card => `scenario:${card.id}`)]);
      if (!allowed.has(section)) throw new Error('不支持的提示词章节');
      if (typeof content !== 'string' || !content.trim() || content.length > 20000 || content.includes('\0')) throw new Error('提示词正文必须为 1 到 20000 字');
      if (expectedRevision !== current.revision) { const error = new Error('提示词已由其他操作更新，请刷新后再保存'); error.status = 409; throw error; }
      const overrides = await this.readOverrides();
      overrides[section] = content;
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(overrides), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filename);
      return this.load();
    });
    this.pending = job.catch(() => {});
    return job;
  }
}
