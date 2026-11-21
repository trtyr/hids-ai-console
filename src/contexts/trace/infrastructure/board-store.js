// trace 上下文 · 基础设施：白板的落盘（P003-T075 批 1）。原子写 + 目录读；投影与不变量都在 domain。
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boardRevision, validIp } from '../domain/board.js';

export class BoardStore {
  constructor(directory) {
    this.directory = directory;
    // 历史版本与当前板同目录下的 `versions/<boardId>/<revision>.json`（P003-T068 A17）：
    // 当前板落盘格式不变（D034 底线 3），历史多文件、按内容版本号命名，重跑前归档旧板。
    this.versions = path.join(directory, 'versions');
  }

  file(boardId) { return path.join(this.directory, `${validIp(boardId) ? `ip:${boardId}` : boardId}.json`); }

  // 与 file() 同一套 id 归类：裸 IPv4 补 `ip:` 前缀，避免 `GET .../203.0.113.7/versions`
  // 与归档时用的 `ip:203.0.113.7` 指向两个目录。
  versionsDirectory(boardId) {
    return path.join(this.versions, validIp(boardId) ? `ip:${boardId}` : String(boardId));
  }

  async read(boardId) {
    try { return JSON.parse(await readFile(this.file(boardId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async save(board) {
    board.updated_at = new Date().toISOString();
    await mkdir(this.directory, { recursive: true });
    const destination = this.file(board.id || board.alert_id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(board), { mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return board;
  }

  // 归档一版：文件名就是内容版本号，同内容重复归档直接跳过（幂等）。
  async archive(board) {
    const boardId = board.id || board.alert_id;
    const revision = boardRevision(board);
    const directory = this.versionsDirectory(boardId);
    const destination = path.join(directory, `${revision}.json`);
    try { await readFile(destination); return { revision, saved: false }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(directory, { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const snapshot = { revision, board_id: boardId, saved_at: new Date().toISOString(), board };
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { revision, saved: true };
  }

  /** 历史版本摘要（新→旧）。坏文件跳过；没归档过就是空数组。 */
  async history(boardId) {
    let names;
    try { names = (await readdir(this.versionsDirectory(boardId))).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const snapshots = await Promise.all(names.map(async name => {
      try { return JSON.parse(await readFile(path.join(this.versionsDirectory(boardId), name), 'utf8')); }
      catch { return null; }
    }));
    return snapshots.filter(snapshot => snapshot?.revision && snapshot.board)
      .sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
  }

  async readVersion(boardId, revision) {
    try {
      return JSON.parse(await readFile(path.join(this.versionsDirectory(boardId), `${revision}.json`), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  /** 目录里全部白板的原始 JSON（坏文件跳过）；排序与摘要是 domain 的事。 */
  async rawAll() {
    let names;
    try { names = (await readdir(this.directory)).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const boards = await Promise.all(names.map(async name => {
      try { return JSON.parse(await readFile(path.join(this.directory, name), 'utf8')); }
      catch { return null; }
    }));
    return boards.filter(Boolean).filter(board => board.id || board.alert_id);
  }
}
