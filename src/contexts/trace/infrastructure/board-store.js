// trace 上下文 · 基础设施：白板的落盘（P003-T075 批 1）。原子写 + 目录读；投影与不变量都在 domain。
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validIp } from '../domain/board.js';

export class BoardStore {
  constructor(directory) { this.directory = directory; }

  file(boardId) { return path.join(this.directory, `${validIp(boardId) ? `ip:${boardId}` : boardId}.json`); }

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
