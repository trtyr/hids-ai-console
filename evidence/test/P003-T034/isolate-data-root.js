// P003-T050 A2：测试的全局根隔离——本模块必须是隔离用例的**第一个 import**。
//
// 为什么必须抢在 `server.js` 之前求值：`server.js:31` 在**模块加载时**就把数据根算死
// （`HIDS_DATA_DIR` 或 `~/.local/share/hids-ai-console`），模块级缺省库（`fp-sessions/`、`wiki/`、
// `rules/`，见 `server.js:55-60`）全按那个根建。测试体里再写 `process.env.HIDS_DATA_DIR` 已经太晚——
// 模块早就加载完了，缺省库还指着真全局根，误报登记一路就写进去（实测一轮套件 +16 份 `fp-sessions/*.json`）。
// ESM 按 import 语句顺序求值，所以把本模块放在第一条即可。
//
// 只做一件事：`HIDS_DATA_DIR` 没设就指到本进程自己的临时根（`mkdtemp`），进程退出时删掉。
// 已设就不覆盖：外层套件或子进程可以整批指定同一个根。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { dataRoot } from '../../../config-store.js';

const configured = typeof process.env.HIDS_DATA_DIR === 'string' ? process.env.HIDS_DATA_DIR.trim() : '';

/** 本进程的数据根。没注入就新建一个临时根并写回 env——只写这一处，别在用例里再塞第二份。 */
export const isolatedRoot = configured || mkdtempSync(path.join(tmpdir(), 'hids-test-data-'));
if (!configured) {
  process.env.HIDS_DATA_DIR = isolatedRoot;
  process.on('exit', () => rmSync(isolatedRoot, { recursive: true, force: true }));
}

/** 真实全局根：**这个进程**的 HOME 下那一条。`HOME` 换了就跟着换——隔离守卫的子进程正是靠这一点验全套件。 */
export const realGlobalRoot = () => path.join(homedir(), '.local', 'share', 'hids-ai-console');

/**
 * 注入是否真的生效：`dataRoot()` 必须等于本模块定下的临时根，且不等于真实全局根。
 *
 * 每条被隔离的用例都调一次——把 `import ...isolate-data-root.js` 那一行删掉，`dataRoot()` 就退回真全局根，
 * 这里恰红（A5 变异自证的那只牙：删掉任一注入点，该文件必红）。
 * 断言取「等值」而不是「前缀是 /tmp」：隔离守卫的子进程把 HOME 也换成临时家目录，只断前缀会放行未注入的文件。
 */
export function assertIsolatedRoot() {
  const root = dataRoot();
  assert.equal(root, isolatedRoot, `数据根没按注入走：${root}（模块加载时 HIDS_DATA_DIR 还是空的？）`);
  assert.notEqual(root, realGlobalRoot(), `数据根落到了真实全局根 ${root}——注入没生效，本文件会写真实运行态`);
}
