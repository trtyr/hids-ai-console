// serve.js —— 起页面用的静态服务 + /api 反代。
// 重点是「任何一条请求都不许把进程打死」：复审第一轮实测 GET /%zz 让 decodeURIComponent 抛
// URIError、进程 exit=1，A1「能打开登录页」的载体直接没了（本文件第 4 条就是那条回归）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createHandler, parsePathname } from '../serve.js';

/** 在临时端口上跑一个 handler，跑完关掉 */
async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    server.closeAllConnections(); // keep-alive 连接会把 close() 拖到超时，测试里直接掐掉
    await new Promise(done => server.close(done));
  }
}

test('parsePathname：正常路径解码，畸形百分号编码返回 null（不抛 URIError）', () => {
  assert.equal(parsePathname('/src/app.js'), '/src/app.js');
  assert.equal(parsePathname('/a%20b.js'), '/a b.js');
  assert.equal(parsePathname('/%zz'), null);
  assert.equal(parsePathname('/%E4%B8'), null);
  assert.equal(parsePathname('/%'), null);
});

test('GET / 返回登录页（200 + text/html）', async () => {
  await withServer(createHandler(), async base => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="root"/);
    assert.match(html, /src\/app\.js/);
  });
});

test('静态资源带正确 MIME；不存在的文件 404', async () => {
  await withServer(createHandler(), async base => {
    const js = await fetch(`${base}/src/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);

    const css = await fetch(`${base}/assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  });
});

test('回归：GET /%zz 回 400，且服务还活着（下一条请求照常 200）', async () => {
  await withServer(createHandler(), async base => {
    const broken = await fetch(`${base}/%zz`);
    assert.equal(broken.status, 400);
    assert.match(await broken.text(), /请求路径无效/);

    const stillAlive = await fetch(`${base}/`);
    assert.equal(stillAlive.status, 200, '畸形 URL 之后服务必须还能服务下一条请求');
  });
});

test('越界路径回 403（%2f 编码的 ../ 也挡住）', async () => {
  await withServer(createHandler(), async base => {
    const traversal = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(traversal.status, 403);
    const alsoTraversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(alsoTraversal.status, 403);
  });
});

test('/api/* 反代：把 Authorization 头原样带给后端，回包原样回给浏览器', async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ authenticated: true, seen: req.headers.authorization ?? null, path: req.url }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const apiOrigin = new URL(`http://127.0.0.1:${upstream.address().port}`);

  try {
    await withServer(createHandler({ apiOrigin }), async base => {
      const response = await fetch(`${base}/api/session`, { headers: { Authorization: 'Basic aGlkczp4' } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.authenticated, true);
      assert.equal(body.seen, 'Basic aGlkczp4', '凭据头必须透传，否则登录永远 401');
      assert.equal(body.path, '/api/session');
    });
  } finally {
    await new Promise(done => upstream.close(done));
  }
});

test('/api/* 反代：后端连不上回 502（页面据此显示「服务异常」而不是「密码错」）', async () => {
  // 127.0.0.1:1 基本不会有人监听 → 连接被拒
  await withServer(createHandler({ apiOrigin: new URL('http://127.0.0.1:1') }), async base => {
    const response = await fetch(`${base}/api/session`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /后端不可达/);
  });
});
