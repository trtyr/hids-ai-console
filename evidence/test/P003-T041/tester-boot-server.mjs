// 测试席（P003-T041）黑盒起服助手：只调文档写明的 createServer()（docs/modules/http-api.md §2：
// 「createServer 是依赖注入点……测试与探针靠传替身换掉」，零参调用 = 模块级真实装配），
// 监听 0 号端口，把实际端口打到 stdout 一行 JSON，供父进程按 HTTP 打。
import { createServer } from '../../../server.js';

const server = createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
