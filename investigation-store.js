import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 每条告警、每种模式保存最近一次成功研判；文件名不直接使用外部告警 ID。
export class InvestigationStore {
  constructor(directory) { this.directory = directory; }

  file(alertId, mode) {
    const digest = createHash('sha256').update(`${mode}:${alertId}`).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async save(result) {
    if (!result?.alert_id || !['deep', 'triage'].includes(result.mode)) throw new Error('研判记录缺少告警 ID 或模式');
    const saved = { ...result, saved_at: new Date().toISOString() };
    const filename = this.file(result.alert_id, result.mode);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(saved), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
    return saved;
  }

  async latest(alertId, mode = 'deep') {
    let saved;
    try { saved = JSON.parse(await readFile(this.file(alertId, mode), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (saved.alert_id !== alertId || saved.mode !== mode) throw new Error('研判记录身份不匹配');
    return saved;
  }

  /**
   * 枚举全部研判记录的对外摘要（P003-T059 A01）：文件名是 sha256 不可枚举，「浏览昨天研判了哪些」
   * 在这里补上。文件名→内容现场读（目录量级 = 告警量，万级以内可接受）；坏文件跳过不拖垮列表。
   * filters：verdicts（存储值匹配，'review' 匹配无结论记录）、from/to（saved_at 闭区间，毫秒）。
   */
  async list({ verdicts = [], from = null, to = null } = {}) {
    let names;
    try { names = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = [];
    for (const name of names.filter(item => item.endsWith('.json'))) {
      let saved;
      try { saved = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')); }
      catch { continue; }
      if (verdicts.length) {
        const verdict = saved?.verdict?.verdict || null;
        if (!verdicts.includes(verdict) && !(verdicts.includes('review') && verdict === null)) continue;
      }
      const savedAt = Date.parse(saved?.saved_at || '');
      // from/to 兼容两种入参：毫秒数（内部）或 ISO 字符串（HTTP 路由经 parseInstant 传入）。
      const fromMs = from == null ? null : typeof from === 'number' ? from : Date.parse(from);
      const toMs = to == null ? null : typeof to === 'number' ? to : Date.parse(to);
      if (fromMs != null && !(Number.isFinite(savedAt) && savedAt >= fromMs)) continue;
      if (toMs != null && !(Number.isFinite(savedAt) && savedAt <= toMs)) continue;
      rows.push({ alert_id: saved?.alert_id ?? null, mode: saved?.mode ?? null,
        verdict: saved?.verdict?.verdict ?? null, verdict_label: saved?.verdict?.verdict_label ?? null,
        confidence: saved?.verdict?.confidence ?? null, saved_at: saved?.saved_at ?? null,
        degraded: saved?.validation?.degraded === true, model: saved?.model ?? null });
    }
    rows.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
    return rows;
  }
}
