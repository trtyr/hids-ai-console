import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');

export class KnowledgeStore {
  constructor(directory) { this.directory = directory; this.pending = new Map(); }

  file(id) {
    if (!validId(id)) { const error = new Error('候选经验 ID 无效'); error.status = 400; throw error; }
    return path.join(this.directory, `${id}.json`);
  }

  async get(id) {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async write(record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.file(record.id);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
    return record;
  }

  async create() {
    const now = new Date().toISOString();
    const record = { id: randomUUID(), title: '新建研判经验', status: 'draft', created_at: now, updated_at: now,
      messages: [{ role: 'assistant', content: '请描述一条你已经人工判断过的牧云告警、结论及判断原因。可以先提供告警 ID、时间、资产、命令或行为；不知道的内容之后再补。', at: now }],
      fields: {}, missing: [], deferred_fields: [], next_field: null,
      next_question: '请描述这条告警、你的研判结论和判断依据。' };
    return this.write(record);
  }

  async list() {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(files.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map(name => this.get(name.slice(0, -5))));
    return records.filter(Boolean).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ id, title, status, scenario_id, created_at, updated_at, missing, messages }) =>
        ({ id, title, status, scenario_id, created_at, updated_at, missing_count: missing?.length || 0, message_count: messages?.length || 0 }));
  }

  async publishedFor(scenarioId) {
    const rows = await this.list();
    const records = await Promise.all(rows.filter(row => row.status === 'published' && row.scenario_id === scenarioId)
      .slice(0, 20).map(row => this.get(row.id)));
    return records.filter(record => Date.parse(record.review?.expires_at || '') > Date.now()).slice(0, 8);
  }

  update(id, change) {
    const previous = this.pending.get(id) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const current = await this.get(id);
      if (!current) { const error = new Error('候选经验不存在'); error.status = 404; throw error; }
      const next = await change(current);
      next.updated_at = new Date().toISOString();
      return this.write(next);
    });
    this.pending.set(id, job);
    void job.finally(() => { if (this.pending.get(id) === job) this.pending.delete(id); }).catch(() => {});
    return job;
  }
}
