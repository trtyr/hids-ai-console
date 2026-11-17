// 起页面用的小服务：静态文件 + /api 反代。零依赖，只用 node 内置模块。
//
// 为什么需要反代：后端（server.js）不提供静态文件，也没有 CORS 头（server.js:53-56），
// 页面若直连 127.0.0.1:8080 会被浏览器拦。这里让页面与 /api 同源。
//
// 用法：node web/serve.js        （HIDS_API_ORIGIN 默认 http://127.0.0.1:8080，HIDS_WEB_PORT 默认 3000）

import { createReadStream, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
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

function proxy(req, res) {
  const upstream = httpRequest(
    {
      protocol: API_ORIGIN.protocol,
      hostname: API_ORIGIN.hostname,
      port: API_ORIGIN.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: API_ORIGIN.host },
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', error => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`后端不可达：${error.message}`);
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(WEB_ROOT, relative));
  if (target !== WEB_ROOT.replace(/\/$/, '') && !target.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('禁止访问');
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('找不到文件');
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

createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`web 已启动：http://${HOST}:${PORT}/    （/api 反代到 ${API_ORIGIN.origin}）`);
});
