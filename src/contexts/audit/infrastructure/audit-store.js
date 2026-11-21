// 审计存储（P003-T062）：append-only JSONL，按天分文件，独立于技术日志的轮转——审计不随 logs/ 的清理消失。
// 落点：`<数据根>/audit/audit-<YYYY-MM-DD>.jsonl`（数据根见 shared/data-root）。目录 0700、文件 0600。
// 一行一条审计事件（auditEvent 的输出）。查询现读文件（时间倒序），支持 from/to/actor/action/object/result 过滤。
import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../../../shared/data-root.js';

const QUERY_LIMIT = 20000;

export function auditDirectory(root = dataRoot()) {
  return path.join(root, 'audit');
}

export class AuditStore {
  constructor(directory = auditDirectory()) {
    this.directory = path.resolve(directory);
  }

  fileFor(at) {
    return path.join(this.directory, `audit-${String(at).slice(0, 10)}.jsonl`);
  }

  /** 追加一条事件（append-only；写前不再校验内容，形状由 domain/auditEvent 保证）。 */
  async record(event) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(this.fileFor(event.at), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }

  /**
   * 查询：按天倒序读文件，行序即发生序；过滤后按 at 倒序切页。
   * filters：{ from, to, actor, action, object, result }（前四个支持部分匹配/前缀，result 精确）。
   */
  async query({ from = null, to = null, actor = null, action = null, object = null, result = null,
    count = 20, offset = 0 } = {}) {
    let names = [];
    try { names = (await readdir(this.directory)).filter(name => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse(); }
    catch (error) { if (error.code === 'ENOENT') return { events: [], total: 0, truncated: false }; throw error; }
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) : null;
    const actorNeedle = actor ? String(actor).toLowerCase() : null;
    const actionNeedle = action ? String(action).toLowerCase() : null;
    const objectNeedle = object ? String(object).toLowerCase() : null;
    const matched = [];
    let truncated = false;
    let scanned = 0;
    outer: for (const name of names) {
      let text;
      try { text = await readFile(path.join(this.directory, name), 'utf8'); }
      catch { continue; }
      const lines = text.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        scanned += 1;
        if (scanned > QUERY_LIMIT) { truncated = true; break outer; }
        let entry;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        if (!entry || typeof entry !== 'object' || typeof entry.at !== 'string' || !entry.action) continue;
        const at = Date.parse(entry.at);
        if (Number.isNaN(at)) continue;
        if (fromMs != null && at < fromMs) continue;
        if (toMs != null && at > toMs) continue;
        if (actorNeedle && !`${entry.actor?.kind || ''}/${entry.actor?.id || ''}`.toLowerCase().includes(actorNeedle)) continue;
        if (actionNeedle && !String(entry.action).toLowerCase().includes(actionNeedle)) continue;
        if (objectNeedle && !JSON.stringify(entry.object ?? {}).toLowerCase().includes(objectNeedle)) continue;
        if (result && entry.result !== result) continue;
        matched.push(entry);
      }
    }
    matched.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { events: matched.slice(offset, offset + count), total: matched.length, truncated };
  }
}
