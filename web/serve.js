// 起页面用的小服务：静态文件 + /api 反代。零依赖，只用 node 内置模块。
//
// 为什么需要反代：后端（server.js）不提供静态文件，也没有 CORS 头（server.js:53-56），
// 页面若直连 127.0.0.1:8080 会被浏览器拦。这里让页面与 /api 同源。
//
// 用法：node web/serve.js        （HIDS_API_ORIGIN 默认 http://127.0.0.1:8080，HIDS_WEB_PORT 默认 3000）
//
// 请求处理抽成 createHandler()，单测可以直接挂到临时端口上（见 web/test/serve.test.js）。
// 任何一条请求都不许把进程打死：畸形 URL → 400，越界路径 → 403，意外异常 → 500。

import { createReadStream, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('.', import.meta.url));
const API_ORIGIN = new URL(process.env.HIDS_API_ORIGIN || 'http://127.0.0.1:8080');
const PORT = Number(process.env.HIDS_WEB_PORT || 3000);
const HOST = process.env.HIDS_WEB_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendText(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

/**
 * 请求路径解码。畸形百分号编码（`/%zz`）、URL 解析失败一律返回 null——
 * 交给调用方回 400，绝不让 URIError 冒到进程顶上（整死服务等于 A1 打不开页面）。
 * @param {string} url
 * @returns {string | null}
 */
export function parsePathname(url) {
  try {
    return decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

function proxy(req, res, apiOrigin) {
  const upstream = httpRequest(
    {
      protocol: apiOrigin.protocol,
      hostname: apiOrigin.hostname,
      port: apiOrigin.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: apiOrigin.host },
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', error => sendText(res, 502, `后端不可达：${error.message}`));
  req.pipe(upstream);
}

function serveStatic(req, res, webRoot, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(webRoot, relative));
  const rootWithSep = webRoot.endsWith(sep) ? webRoot : webRoot + sep;
  if (target !== webRoot.replace(/\/$/, '') && !target.startsWith(rootWithSep)) {
    return sendText(res, 403, '禁止访问');
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return sendText(res, 404, '找不到文件');
  }
  if (stat.isDirectory()) {
    res.writeHead(302, { Location: `${pathname.replace(/\/$/, '')}/index.html` });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(res);
}

/**
 * 造请求处理器（单测用这个，别直接起进程）。
 * @param {{ webRoot?: string, apiOrigin?: URL }} [options]
 */
export function createHandler(options = {}) {
  const webRoot = options.webRoot ?? WEB_ROOT;
  const apiOrigin = options.apiOrigin ?? API_ORIGIN;

  return function handle(req, res) {
    try {
      const pathname = parsePathname(req.url);
      if (pathname === null) return sendText(res, 400, '请求路径无效');
      if (pathname === '/api' || pathname.startsWith('/api/')) return proxy(req, res, apiOrigin);
      // _handoff 是交接件（设计稿副本、设计期契约快照、zip 包），不是产品资源：不发布
      if (pathname === '/_handoff' || pathname.startsWith('/_handoff/')) return sendText(res, 404, '找不到文件');
      return serveStatic(req, res, webRoot, pathname);
    } catch (error) {
      return sendText(res, 500, `服务内部错误：${error.message}`);
    }
  };
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  createServer(createHandler()).listen(PORT, HOST, () => {
    console.log(`web 已启动：http://${HOST}:${PORT}/    （/api 反代到 ${API_ORIGIN.origin}）`);
  });
}
