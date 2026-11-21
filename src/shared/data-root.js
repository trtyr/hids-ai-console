// 运行态数据根的唯一定义（P003-T034 立，T075 批 0 摘成零依赖叶子——D034 §8.4 #1）。
//
// `HIDS_DATA_DIR` 指向哪就落哪，没设就落机器全局的 `~/.local/share/hids-ai-console/`。
// **仓库里一个字都不写**——测试与探针注入 tmp 目录，别让它们写真实全局根。
//
// 为什么要摘叶子：原来这个纯路径函数住在 `config-store.js`，而 config-store 为了校验配置值
// import 了 RpcClient 与 ChatModelClient——结果是 wiki-store / rule-store / prompt-store 只为要一个路径，
// 依赖图里全挂上了两个传输客户端（D034 §8.2「病态门面」实测）。摘出来之后：
//   · 本文件零 import，谁都能安全依赖；
//   · `config-store.js` 改为从这里 re-export（旧 import 路径 `config-store.js` 的 `dataRoot` 照旧可用，
//     批 6 迁完 config-store 后删掉 re-export）。
//
// env / home 可注入：单测用字面量，不碰真实 process.env 与真实 HOME。
// 空串与纯空白算「没设」（与 HIDS_CASES_DIR 同一个口径）；相对路径按当前工作目录绝对化。
import { homedir } from 'node:os';
import path from 'node:path';

export function dataRoot({ env = process.env, home = homedir() } = {}) {
  const configured = typeof env.HIDS_DATA_DIR === 'string' ? env.HIDS_DATA_DIR.trim() : '';
  if (configured) return path.resolve(configured);
  return path.join(home, '.local', 'share', 'hids-ai-console');
}

// 仓库根目录的唯一定义（P003-T075 批 4）：knowledge 系文件的种子源路径（wiki/、rules/、prompts/、
// triage-rules.example.json）原来各自用 `import.meta.url` 解析——迁移后模块位置变了路径就断。
// 摘成共享叶子：本文件在 src/shared/ 固定位置，上跳 2 级 = 仓库根，不受后续迁移影响。
import { fileURLToPath } from 'node:url';

export function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}
