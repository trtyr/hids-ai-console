import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
}
