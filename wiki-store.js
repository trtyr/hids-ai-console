import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = process.env.HIDS_WIKI_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'wiki');
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
  constructor(directory = defaultDirectory) { this.directory = directory; this.pending = Promise.resolve(); }

  file(filename) {
    const parts = String(filename || '').split('/');
    const regular = parts.length === 2 && wikiDirectories.has(parts[0]) &&
      /^[\p{L}\p{N}_-]+\.md$/u.test(parts[1]);
    const rootDocument = parts.length === 1 && /^(?:index|rules|log|_schema)\.md$/.test(parts[0]);
    if (!regular && !rootDocument) throw Object.assign(new Error('知识库页面路径无效'), { status: 400 });
    return path.join(this.directory, filename);
  }

  async browse() {
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

  async list() {
    const groups = await readdir(this.directory, { withFileTypes: true });
    const rows = await Promise.all(groups.filter(item => item.isDirectory() && !item.name.startsWith('_'))
      .map(async group => {
        const files = await readdir(path.join(this.directory, group.name));
        return Promise.all(files.filter(file => pagePattern.test(`${group.name}/${file}`)).map(async file => {
          const filename = `${group.name}/${file}`;
          return metadata(filename, await readFile(this.file(filename), 'utf8'));
        }));
      }));
    return rows.flat().filter(item => item.status !== 'deprecated').sort((a, b) => a.path.localeCompare(b.path));
  }

  async get(filename) {
    const source = await readFile(this.file(filename), 'utf8');
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
      const historyDir = path.join(path.dirname(this.directory), '.data', 'wiki-history');
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
          const historyDir = path.join(path.dirname(this.directory), '.data', 'wiki-history');
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
