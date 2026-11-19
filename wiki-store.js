import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat as statFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = process.env.HIDS_WIKI_DIR || wikiLibraryDirectory(); // 库目录与历史落点见文件末尾
const idPattern = /^[A-Z]{2,3}-\d+[a-z]?$/;
const pagePattern = /^(?:common|webshell|memwebshell|rasp|revshell|suspicious-command|cmdaudit|malware|bruteforce|honeypot|elevation|abnormal-login|net|customer-experience)\/[A-Z]{2,3}-\d+[a-z]?\.md$/;
const wikiDirectories = new Set(['common', 'webshell', 'memwebshell', 'rasp', 'revshell',
  'suspicious-command', 'cmdaudit', 'malware', 'bruteforce', 'honeypot', 'elevation',
  'abnormal-login', 'net', 'customer-experience', '_evidence', 'concepts']);
const classForEvent = {
  honeypot: 'honeypot', webshell: 'webshell', memory_webshell: 'memwebshell', memory_security: 'rasp',
  revshell: 'revshell', suspicious_operation: 'suspicious-command', command_session: 'cmdaudit',
  command_whitelist: 'suspicious-command', malware: 'malware', brute_force: 'bruteforce',
  elevation_process: 'elevation', abnormal_login: 'abnormal-login', network_audit: 'net'
};
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

function metadata(filename, source) {
  const head = source.startsWith('---\n') ? source.split('\n---\n', 2)[0].slice(4) : '';
  const field = name => head.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() || '';
  const heading = source.match(/^#\s+(.+)$/m)?.[1] || filename;
  return { path: filename, id: field('id') || path.basename(filename, '.md'),
    title: (field('title') || heading).replace(/^['"]|['"]$/g, ''), status: field('status') || 'reference',
    updated: field('updated'), revision: hash(source), characters: source.length };
}

export class WikiStore {
  constructor(directory = defaultDirectory,
    { historyDirectory = historyDirectoryFor(directory), seedFrom = seedSourceFor(directory) } = {}) {
    this.directory = directory;
    // 历史版本落点（P003-T034）：数据根库→数据根，换过的目录→跟目录走，见文件末尾。
    this.historyDirectory = historyDirectory;
    // 种子源（P003-T041 A2）：只有「缺省的数据根库」才从仓内 `wiki/` 初始化一次；注入的目录一律不碰仓库。
    this.seedSource = seedFrom;
    this.seeding = null;
    this.pending = Promise.resolve();
    // 目录索引缓存（A7）：按（路径, mtimeMs, size）签名缓存已解析的页面行。
    // 一次研判里 agentIndex / agentPage / agentContextPages 会反复要目录：签名不变就不再读盘、不再重解析头部。
    this.listCache = null;
  }

  // 数据根里还没有这本库时，从仓内 `wiki/` 初始化一次（A2）。已存在就一个字都不动。
  // 记忆化在模块级 `ensureWikiLibrary()` 上而不是实例上：`prompt-store.js` 的 SOP 也从这本库读，
  // 两个消费者共用同一份「只初始化一次」，不会一边刚拷完、另一边又拷一遍。
  async ready() {
    if (!this.seedSource) return;
    this.seeding ||= this.directory === wikiLibraryDirectory()
      ? ensureWikiLibrary() : seedLibrary(this.directory, this.seedSource);
    await this.seeding;
  }

  file(filename) {
    const parts = String(filename || '').split('/');
    const regular = parts.length === 2 && wikiDirectories.has(parts[0]) &&
      /^[\p{L}\p{N}_-]+\.md$/u.test(parts[1]);
    const rootDocument = parts.length === 1 && /^(?:index|rules|log|_schema)\.md$/.test(parts[0]);
    if (!regular && !rootDocument) throw Object.assign(new Error('知识库页面路径无效'), { status: 400 });
    return path.join(this.directory, filename);
  }

  async browse() {
    await this.ready();
    const top = await readdir(this.directory, { withFileTypes: true });
    const names = top.filter(item => item.isFile() && /\.md$/.test(item.name)).map(item => item.name);
    const folders = top.filter(item => item.isDirectory() && wikiDirectories.has(item.name));
    for (const folder of folders) {
      for (const item of await readdir(path.join(this.directory, folder.name)))
        if (/\.md$/.test(item)) names.push(`${folder.name}/${item}`);
    }
    const pages = await Promise.all(names.map(async filename => {
      try { return metadata(filename, await readFile(this.file(filename), 'utf8')); }
      catch (cause) { if (cause.status === 400) return null; throw cause; }
    }));
    const rank = filename => filename === 'index.md' ? 0 : filename === 'rules.md' ? 1 :
      filename === '_schema.md' ? 2 : filename.startsWith('common/') ? 3 :
        filename.startsWith('customer-experience/') ? 4 : filename.startsWith('concepts/') ? 5 :
          filename.startsWith('_evidence/') ? 7 : 6;
    return pages.filter(Boolean).sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  }

  // 签名只 stat 不 read：文件没动就不必重读正文与头部。
  async #listSignature() {
    const groups = await readdir(this.directory, { withFileTypes: true });
    const parts = [];
    for (const group of groups.filter(item => item.isDirectory() && !item.name.startsWith('_'))) {
      const files = await readdir(path.join(this.directory, group.name));
      for (const file of files) {
        const filename = `${group.name}/${file}`;
        if (!pagePattern.test(filename)) continue;
        let info;
        try { info = await statFile(this.file(filename)); }
        catch (cause) {
          // readdir 与 stat 之间被删掉：当作不存在，不让旧快照借尸还魂。
          if (cause.code === 'ENOENT') continue;
          // 文件名过不了 file() 的路径校验：readdir 出的怪文件名跳过，不把整个目录读卡住。
          if (cause.status === 400) continue;
          throw cause;
        }
        parts.push(`${filename}:${info.mtimeMs}:${info.size}`);
      }
    }
    return parts.sort().join('\n');
  }

  async list() {
    await this.ready();
    const signature = await this.#listSignature();
    if (this.listCache?.signature === signature) return [...this.listCache.rows];
    const groups = await readdir(this.directory, { withFileTypes: true });
    const rows = await Promise.all(groups.filter(item => item.isDirectory() && !item.name.startsWith('_'))
      .map(async group => {
        const files = await readdir(path.join(this.directory, group.name));
        return Promise.all(files.filter(file => pagePattern.test(`${group.name}/${file}`)).map(async file => {
          const filename = `${group.name}/${file}`;
          return metadata(filename, await readFile(this.file(filename), 'utf8'));
        }));
      }));
    const listed = rows.flat().filter(item => item.status !== 'deprecated').sort((a, b) => a.path.localeCompare(b.path));
    this.listCache = { signature, rows: listed };
    return [...listed];
  }

  // 页面不存在时抛 404，正文只给相对路径：readFile 的 ENOENT message 带服务器绝对路径
  // （`open '<directory>/<filename>'`），不能让它经 HTTP 404 回给调用方。
  async get(filename) {
    await this.ready();
    let source;
    try { source = await readFile(this.file(filename), 'utf8'); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      throw Object.assign(new Error(`知识库页面不存在：${filename}`), { status: 404, code: 'ENOENT' });
    }
    return { ...metadata(filename, source), content: source };
  }

  async getById(id) {
    if (!idPattern.test(id)) return null;
    const page = (await this.list()).find(item => item.id === id);
    return page ? this.get(page.path) : null;
  }

  async search(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || q.length > 100) return [];
    const pages = await this.list();
    return pages.filter(page => `${page.id} ${page.title}`.toLowerCase().includes(q)).slice(0, limit);
  }

  async agentIndex(eventType) {
    const category = classForEvent[eventType];
    if (!category) throw new Error(`Wiki 没有 ${eventType} 对应的判据分类`);
    const pages = (await this.list()).filter(page => page.status === 'active' &&
      (page.path.startsWith('common/') || page.path.startsWith(`${category}/`)));
    if (!pages.length) throw new Error(`Wiki 分类 ${category} 没有可用判据`);
    return { category, pages: pages.map(({ id, title, path }) => ({ id, title, path })),
      hint: '先根据当前告警事实挑选必要判据，按编号读取正文。Wiki 是判断依据，不是当前告警的取证记录。' };
  }

  async agentPage(eventType, id) {
    const index = await this.agentIndex(eventType);
    const found = index.pages.find(page => page.id === id);
    if (!found) throw new Error(`当前场景不可读取 Wiki 判据 ${id}`);
    const page = await this.get(found.path);
    return { id: page.id, title: page.title, path: page.path,
      content: page.content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 9000) };
  }

  async agentContextPages(eventType) {
    const index = await this.agentIndex(eventType);
    const selected = index.pages.filter(page => page.path.startsWith('common/') ||
      page.path.startsWith(`${index.category}/`)).slice(0, 4);
    return Promise.all(selected.map(page => this.agentPage(eventType, page.id)));
  }

  async agentSearch(eventType, keyword) {
    const q = String(keyword || '').trim().toLowerCase();
    if (q.length < 2 || q.length > 80) throw new Error('Wiki 检索词需为 2 到 80 字');
    const index = await this.agentIndex(eventType);
    const pages = await Promise.all(index.pages.map(page => this.get(page.path)));
    return pages.map(page => {
      const at = page.content.toLowerCase().indexOf(q);
      return at < 0 ? null : { id: page.id, title: page.title,
        excerpt: page.content.slice(Math.max(0, at - 80), at + q.length + 120).replace(/\s+/g, ' ') };
    }).filter(Boolean).slice(0, 8);
  }

  async health() {
    const pages = await this.browse();
    const criteria = pages.filter(page => pagePattern.test(page.path));
    const active = criteria.filter(page => page.status === 'active');
    const ids = new Set(criteria.map(page => page.id));
    const counts = new Map();
    for (const page of criteria) counts.set(page.id, (counts.get(page.id) || 0) + 1);
    const paths = new Set(pages.map(page => page.path));
    const issues = [];
    for (const [id, count] of counts) if (count > 1)
      issues.push({ path: id, kind: 'duplicate_id', message: `判据编号 ${id} 重复 ${count} 次` });
    for (const page of active) {
      const source = (await this.get(page.path)).content;
      if (!/^evidence:\s*\[[^\]]+\]/m.test(source) && !/^source:\s*\S+/m.test(source))
        issues.push({ path: page.path, kind: 'missing_source', message: '缺少判据来源' });
      for (const ref of source.match(/^refs:\s*\[([^\]]*)\]/m)?.[1]?.match(/[A-Z]{2,3}-\d+[a-z]?/g) || [])
        if (!ids.has(ref)) issues.push({ path: page.path, kind: 'broken_ref', message: `引用的判据 ${ref} 不存在` });
      for (const ref of source.match(/^evidence:\s*\[([^\]]*)\]/m)?.[1]?.split(',').map(x => x.trim()).filter(Boolean) || [])
        if (!paths.has(ref)) issues.push({ path: page.path, kind: 'missing_evidence', message: `证据页 ${ref} 不存在` });
    }
    return { checked_at: new Date().toISOString(), active_pages: active.length, issues };
  }

  update(filename, content, expectedRevision, note = '通过知识库工作台更新') {
    const job = this.pending.then(async () => {
      await this.ready();
      if (!pagePattern.test(filename)) throw Object.assign(new Error('只允许修订判据页和客户经验页'), { status: 400 });
      const previous = await this.get(filename);
      if (previous.revision !== expectedRevision) throw Object.assign(new Error('知识库页面已更新，请刷新后再提交'), { status: 409 });
      if (typeof content !== 'string' || !content.trim() || content.length > 30000 || content.includes('\0'))
        throw Object.assign(new Error('页面正文必须为 1 到 30000 字'), { status: 400 });
      const next = metadata(filename, content);
      if (next.id !== previous.id || !idPattern.test(next.id) || !['active', 'draft', 'deprecated'].includes(next.status))
        throw Object.assign(new Error('页面 ID 必须保持一致，状态须为 active、draft 或 deprecated'), { status: 400 });
      if (!/^evidence:\s*\[[^\]]+\]/m.test(content) && !/^source:\s*.+/m.test(content))
        throw Object.assign(new Error('判据需要 evidence 或 source 出处'), { status: 400 });
      const historyDir = this.historyDirectory;
      await mkdir(historyDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(historyDir, `${previous.id}-${previous.revision}.md`), previous.content,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const filenameOnDisk = this.file(filename);
      await mkdir(path.dirname(filenameOnDisk), { recursive: true });
      const temporary = `${filenameOnDisk}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filenameOnDisk);
      await appendFile(path.join(this.directory, 'log.md'),
        `\n## [${new Date().toISOString()}] update | ${previous.id}\n影响判据：${previous.id}\n要点：${String(note).replace(/\s+/g, ' ')}；上版 ${previous.revision}，新版 ${next.revision}。\n`, 'utf8');
      return this.get(filename);
    });
    this.pending = job.catch(() => {});
    return job;
  }

  async checkBundle(changes, evidence = null) {
    const pages = await this.browse();
    const knownIds = new Set(pages.filter(page => idPattern.test(page.id)).map(page => page.id));
    const issues = [];
    const counts = new Map();
    for (const page of pages.filter(page => pagePattern.test(page.path)))
      counts.set(page.id, (counts.get(page.id) || 0) + 1);
    for (const [id, count] of counts) if (count > 1) issues.push(`判据编号 ${id} 重复 ${count} 次`);
    if (evidence && (!/^_evidence\/[a-z0-9-]{8,100}\.md$/.test(evidence.path) ||
        !/^---\n[\s\S]*?\n---\n/.test(evidence.content || '') ||
        !/^id:\s*EV-[A-Za-z0-9-]+$/m.test(evidence.content || '') ||
        !/^source:\s*\S+/m.test(evidence.content || '') ||
        !/^supports:\s*\[[^\]]+\]/m.test(evidence.content || '')))
      issues.push('新证据页缺少有效路径、编号、来源或支持范围');
    if (evidence && pages.some(page => page.path === evidence.path || page.id === metadata(evidence.path, evidence.content).id))
      issues.push(`证据页路径或编号已存在：${evidence.path}`);
    for (const item of changes || []) {
      const filename = item.path;
      if (!pagePattern.test(filename) || filename.startsWith('customer-experience/')) {
        issues.push(`无效的判据路径：${filename}`); continue;
      }
      const content = item.content || '';
      const meta = metadata(filename, content);
      if (meta.id !== path.basename(filename, '.md')) issues.push(`${filename} 的编号与路径不符`);
      if (!idPattern.test(meta.id) || !new RegExp(`^id:\\s*${meta.id}\\s*$`, 'm').test(content))
        issues.push(`${filename} 缺少明确的判据编号`);
      if (!['active', 'draft', 'deprecated'].includes(meta.status)) issues.push(`${filename} 状态无效`);
      if (!/^evidence:\s*\[[^\]]+\]/m.test(content) && !/^source:\s*\S+/m.test(content))
        issues.push(`${filename} 缺少来源`);
      for (const field of ['title', 'applies_to', 'status', 'updated'])
        if (!new RegExp(`^${field}:\\s*\\S+`, 'm').test(content)) issues.push(`${filename} 缺少 ${field}`);
      if (!/^updated:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(content)) issues.push(`${filename} 更新日期无效`);
      for (const ref of content.match(/^refs:\s*\[([^\]]*)\]/m)?.[1]?.match(/[A-Z]{2,3}-\d+[a-z]?/g) || [])
        if (!knownIds.has(ref)) issues.push(`${filename} 引用了不存在的判据 ${ref}`);
      for (const ref of content.match(/^evidence:\s*\[([^\]]*)\]/m)?.[1]?.split(',').map(x => x.trim()).filter(Boolean) || []) {
        if (!/^_evidence\/[\w-]+\.md$/.test(ref)) { issues.push(`${filename} 证据路径无效：${ref}`); continue; }
        if (ref !== evidence?.path && !pages.some(page => page.path === ref))
          issues.push(`${filename} 引用了不存在的证据 ${ref}`);
      }
      if (meta.status === 'deprecated' && !/^deprecated_reason:\s*\S+/m.test(content))
        issues.push(`${filename} 退役时须说明原因`);
    }
    return issues;
  }

  publishBundle(changes, evidence, audit) {
    const job = this.pending.then(async () => {
      await this.ready();
      if (!Array.isArray(changes) || !changes.length || changes.length > 6 ||
          !audit || typeof audit.reviewer !== 'string' || audit.reviewer.trim().length < 2)
        throw Object.assign(new Error('维护发布需要 1 至 6 条判据修订及审核人'), { status: 400 });
      const seen = new Set();
      const prepared = [];
      const issues = await this.checkBundle(changes, evidence);
      if (issues.length) throw Object.assign(new Error(`维护草案未通过检查：${issues.slice(0, 5).join('；')}`), { status: 400 });
      for (const change of changes) {
        if (!pagePattern.test(change.path) || change.path.startsWith('customer-experience/') || seen.has(change.path))
          throw Object.assign(new Error('维护草案包含重复或无效的判据路径'), { status: 400 });
        seen.add(change.path);
        const previous = await this.get(change.path);
        if (previous.revision !== change.page_revision)
          throw Object.assign(new Error(`判据 ${previous.id} 已更新，请重新整理草案`), { status: 409 });
        const content = change.content;
        if (typeof content !== 'string' || content.length < 100 || content.length > 30000 || content.includes('\0'))
          throw Object.assign(new Error(`判据 ${previous.id} 正文无效`), { status: 400 });
        const next = metadata(change.path, content);
        if (next.id !== previous.id || !['active', 'draft', 'deprecated'].includes(next.status) ||
            !/^title:\s*\S+/m.test(content) || !/^updated:\s*\d{4}-\d{2}-\d{2}/m.test(content) ||
            !/^applies_to:\s*\[[^\]]+\]/m.test(content) ||
            !/^evidence:\s*\[[^\]]+\]/m.test(content) && !/^source:\s*\S+/m.test(content))
          throw Object.assign(new Error(`判据 ${previous.id} 缺少编号、适用范围、状态、日期或来源`), { status: 400 });
        prepared.push({ path: change.path, previous, content });
      }
      if (evidence) {
        if (!/^_evidence\/[a-z0-9-]{8,100}\.md$/.test(evidence.path) ||
            typeof evidence.content !== 'string' || evidence.content.length > 12000 ||
            !/^id:\s*EV-[A-Za-z0-9-]+$/m.test(evidence.content) ||
            !/^source:\s*\S+/m.test(evidence.content))
          throw Object.assign(new Error('反馈证据页格式无效'), { status: 400 });
        for (const item of prepared) if (!item.content.includes(evidence.path))
          throw Object.assign(new Error(`判据 ${item.previous.id} 未引用本次反馈证据`), { status: 400 });
        try { await readFile(this.file(evidence.path));
          throw Object.assign(new Error('反馈证据页已存在'), { status: 409 });
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      const changed = [];
      try {
        for (const item of prepared) {
          const historyDir = this.historyDirectory;
          await mkdir(historyDir, { recursive: true, mode: 0o700 });
          const backup = path.join(historyDir, `${item.previous.id}-${item.previous.revision}.md`);
          await writeFile(backup, item.previous.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
            .catch(error => { if (error.code !== 'EEXIST') throw error; });
        }
        if (evidence) {
          await mkdir(path.dirname(this.file(evidence.path)), { recursive: true, mode: 0o700 });
          await writeFile(this.file(evidence.path), evidence.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        }
        for (const item of prepared) {
          const filename = this.file(item.path);
          const temporary = `${filename}.${randomUUID()}.tmp`;
          await writeFile(temporary, item.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, filename);
          changed.push(item);
        }
        await appendFile(this.file('log.md'),
          `\n## [${new Date().toISOString()}] ingest | ${prepared.map(item => item.previous.id).join(', ')}\n审核人：${audit.reviewer.trim()}\n反馈案件：${audit.case_id || '无'}\n证据：${evidence?.path || '原页面出处'}\n回放：${audit.replay_status || '未记录'}，样本 ${Number(audit.replay_count) || 0} 条\n要点：${String(audit.note || '').replaceAll('\n', ' ').slice(0, 500)}\n`, 'utf8');
      } catch (cause) {
        for (const item of changed.reverse()) {
          const temporary = `${this.file(item.path)}.${randomUUID()}.tmp`;
          await writeFile(temporary, item.previous.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, this.file(item.path));
        }
        if (evidence) await unlink(this.file(evidence.path)).catch(() => {});
        throw cause;
      }
      return Promise.all(prepared.map(item => this.get(item.path)));
    });
    this.pending = job.catch(() => {});
    return job;
  }

  createExperience(filename, content) {
    const job = this.pending.then(async () => {
      await this.ready();
      if (!/^customer-experience\/EX-\d+\.md$/.test(filename))
        throw Object.assign(new Error('客户经验页面路径无效'), { status: 400 });
      const page = metadata(filename, content);
      if (page.id !== path.basename(filename, '.md') || page.status !== 'active' ||
        !/^source:\s*.+/m.test(content) || content.length > 30000)
        throw Object.assign(new Error('客户经验缺少有效编号、发布状态或来源'), { status: 400 });
      await mkdir(path.dirname(this.file(filename)), { recursive: true });
      await writeFile(this.file(filename), content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const indexFile = path.join(this.directory, 'customer-experience', 'index.md');
      await writeFile(indexFile, '# 客户经验 · 目录\n\n经人工审核的客户处置经验；每次复用仍需核对当前告警。\n\n',
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await appendFile(indexFile, `- [${page.id}](${path.basename(filename)}) · ${page.title}\n`, 'utf8');
      await appendFile(path.join(this.directory, 'log.md'),
        `\n## [${new Date().toISOString()}] ingest | ${page.id}\n影响判据：${page.id}\n要点：客户经验经对话整理和人工审核后发布。\n`, 'utf8');
      return this.get(filename);
    });
    this.pending = job.catch(() => {});
    return job;
  }

  async publishedFor(scenarioId) {
    const pages = (await this.list()).filter(page => page.path.startsWith('customer-experience/') && page.status === 'active');
    const records = await Promise.all(pages.map(async page => {
      const source = (await this.get(page.path)).content;
      const block = source.match(/```json\s*([\s\S]*?)\s*```/);
      if (!block) return null;
      try { return JSON.parse(block[1]); } catch { return null; }
    }));
    return records.filter(record => record?.scenario_id === scenarioId && record.review &&
      Date.parse(record.review.expires_at || '') > Date.now()).slice(0, 8);
  }
}

// ── 判据库目录与历史版本落点（P003-T034）────────────────────────────────────
// 定义在文件末尾、import 也放末尾（ESM 会提升，模块顶层就能用），是为了不挪动上面所有 `wiki-store.js:NNN`
// 引用的行号——`server.js` 末尾的 runtimePaths() 是同一个理由。
//   · 活数据（判据页）落**数据根**下的 `wiki/`（数据根见 config-store.js 的
//     dataRoot()：`HIDS_DATA_DIR`，没设就是 `~/.local/share/hids-ai-console`）——仓库里一个字都不写；
//     仓内 `wiki/` 退成**只读种子**：数据根里还没有这本库时整目录拷一次（P003-T041 A1/A2）；
//   · 备份落数据根下的 `wiki-history/`；
//   · 判据库被 `HIDS_WIKI_DIR` / 构造参数换到别处：备份跟着判据库走（同级 `.data/wiki-history/`）——判据库搬到
//     别处部署，它的备份该跟它走，也不该让单测往真实全局根写；那种目录不种子、不碰仓库。
// 判「是数据根库」只能拿 `wikiLibraryDirectory()` 比：`defaultDirectory` 会被 `HIDS_WIKI_DIR` 换掉，拿它当判据等于
// 「设了 HIDS_WIKI_DIR 就当数据根库」，历史就落到数据根，与上面这条规则相反（P003-T034 复审打回的那条）。
// 仓内 `wiki/` 这个分支留着：单测/探针显式传仓内目录时，历史仍落数据根，不往仓库里写（P003-T034 A3）。
function builtinWikiDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'wiki');
}

/** 判据库缺省目录：数据根下的 `wiki/`（`HIDS_WIKI_DIR` 仍可整个换掉，见文件头 `defaultDirectory`）。 */
export function wikiLibraryDirectory() {
  return path.join(dataRoot(), 'wiki');
}

function historyDirectoryFor(directory) {
  return directory === wikiLibraryDirectory() || directory === builtinWikiDirectory()
    ? path.join(dataRoot(), 'wiki-history')
    : path.join(path.dirname(directory), '.data', 'wiki-history');
}

function seedSourceFor(directory) {
  return directory === wikiLibraryDirectory() ? builtinWikiDirectory() : null;
}

// 数据根判据库的「只初始化一次」：`WikiStore.ready()` 与 `PromptStore.load()`（SOP 也读这本库）共用这一个
// 记忆化 promise。模块级而不是实例级——两个消费者各自 new 一个 WikiStore 也只拷一次。
let wikiSeeded = null;

export function ensureWikiLibrary() {
  wikiSeeded ||= seedLibrary(wikiLibraryDirectory(), builtinWikiDirectory());
  return wikiSeeded;
}

import { dataRoot } from './config-store.js';
import { seedLibrary } from './rule-store.js';

// P003-T039 A4：判据页给模型的常驻形态不是整页正文，而是「编号 + 标题 + 要点摘要」；
// 正文按需走 wiki_page，返回摘要 + 命中段。以下两个纯函数只做文本切分，碰不到判定逻辑。

export function pageBody(content) {
  return String(content || '').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

const collapse = text => String(text || '').replace(/\s+/g, ' ').trim();
const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const judgmentTerms = ['判定', '结论', '误报', '威胁', '必查', '要求', '限制', '边界', '适用'];

function paragraphs(body) {
  return body.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
}

// 判据页多数没有二级标题，条目写成编号清单：按编号项切段，命中段才带得上「第 4 步 结论」这种定位。
function splitNumbered(block) {
  const pieces = [];
  let current = [];
  for (const line of block.split('\n')) {
    if (/^\d+\.\s/.test(line) && current.length) { pieces.push(current.join('\n')); current = [line]; }
    else current.push(line);
  }
  if (current.length) pieces.push(current.join('\n'));
  return pieces;
}

// 段内留标题：标题行单独成段并给后面的正文当标题，命中段里带着标题才看得懂说的是哪一步。
function sections(body) {
  const result = [];
  let title = '';
  for (const block of paragraphs(body)) {
    for (const piece of splitNumbered(block)) {
      const heading = piece.match(/^#{1,6}\s+(.+)$/);
      if (heading && piece.trim().startsWith('#')) {
        title = heading[1].trim();
        const rest = piece.split('\n').filter(line => !/^#{1,6}\s/.test(line)).join('\n').trim();
        if (rest) result.push({ title, text: collapse(rest) });
        continue;
      }
      const text = collapse(piece);
      if (text) result.push({ title, text });
    }
  }
  return result;
}

// 要点摘要：正文里第一段有内容的（跳过标题、表格分隔线、纯清单符号）。
export function pageSummary(content, limit = 200) {
  const body = pageBody(content);
  const first = sections(body).find(section => section.text.length >= 12);
  if (first) return cut(collapse(first.text.replace(/^>+\s*/, '')), limit);
  return cut(collapse(body.replace(/^#{1,6}\s+/gm, '')), limit);
}

// 命中段：给了 keyword 就按关键词取段；没给就按判定用语（判定/结论/误报/威胁/必查…）打分取段。
export function pageExcerpts(content, { keyword = '', limit = 3, maxChars = 600 } = {}) {
  const all = sections(pageBody(content));
  const needle = collapse(keyword).toLowerCase();
  let picked;
  if (needle) {
    picked = all.filter(section => `${section.title} ${section.text}`.toLowerCase().includes(needle));
    if (!picked.length) picked = all;
  } else {
    const scored = all.map((section, index) => ({ section, index,
      score: judgmentTerms.reduce((sum, term) => sum + (section.text.split(term).length - 1), 0) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    picked = scored.slice(0, limit).sort((a, b) => a.index - b.index).map(entry => entry.section);
  }
  if (!picked.length) picked = all.slice(0, 2);
  return picked.slice(0, limit).map(section => ({ title: section.title, text: cut(section.text, maxChars) }));
}
