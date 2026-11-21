// Playwright 不是本仓依赖（零依赖约束）：从环境里已有的安装加载。
// 用法：PLAYWRIGHT_MODULE=file:///home/trtyr/code/sec-agent-web/node_modules/playwright/index.mjs \
//        node evidence/test/P003-T008/run-verify.mjs http://127.0.0.1:4174/ evidence/test/P003-T008
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(playwrightModule);
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:4174/';
const outDirArg = process.argv[3];
const out = outDirArg ?? new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const api = [];
page.on('response', async response => {
  const url = response.url();
  if (!url.includes('/api/')) return;
  let size = null;
  try { size = (await response.body()).length; } catch { /* stream */ }
  api.push({ method: response.request().method(), url, status: response.status(), bytes: size });
});
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

const results = [];
async function capture(name, note = null) {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'screenshots', `${name}.png`) });
  const excerpt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1600);
  results.push({ name, hash: await page.evaluate(() => location.hash), interaction: note,
    calls: [], excerpt });
  return excerpt;
}
function mark() { return api.length; }
function callsSince(start) { return api.slice(start); }

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.fill('#username', 'verify');
await page.fill('#password', 'verify');
await page.click('[data-role="submit"]');
await page.waitForSelector('nav.nav', { timeout: 20000 });
await page.waitForTimeout(800);

// 1 总览：切到近 7 天并刷新（触发 /api/agent/triage/status?since=…，数值来自接口）
let start = mark();
await page.evaluate(() => { location.hash = '#/overview'; });
await page.waitForTimeout(800);
const overviewSelect = page.locator('select').first();
if (await overviewSelect.count()) await overviewSelect.selectOption({ index: 2 });
else await page.click('[data-role="refresh"]');
await page.waitForTimeout(1200);
await capture('01-overview', '选择「近 7 天」时间窗');
results.at(-1).calls = callsSince(start);

// 2 告警主列表：先截列表，再点第一行「详情」进详情
start = mark();
await page.evaluate(() => { location.hash = '#/alerts'; });
await page.waitForSelector('[data-role="rows"] tr', { timeout: 15000 }).catch(() => {});
await capture('02-alerts');
results.at(-1).calls = callsSince(start);

const detailStart = mark();
const detailLink = page.locator('a[href^="#/alert-detail/"]').first();
let detailNote = '无详情链接';
if (await detailLink.count()) {
  await detailLink.click();
  await page.waitForTimeout(1400);
  detailNote = `点击详情 ${await page.evaluate(() => location.hash)}`;
}
await capture('03-alert-detail', detailNote);
results.at(-1).calls = callsSince(detailStart);

// 3 溯源列表 → 白板
start = mark();
await page.evaluate(() => { location.hash = '#/trace'; });
await page.waitForSelector('[data-role="rows"] tr', { timeout: 15000 }).catch(() => {});
await capture('04-trace-list');
results.at(-1).calls = callsSince(start);

const boardStart = mark();
const boardLink = page.locator('a[href^="#/trace-board/"]').first();
let boardNote = '无白板链接';
if (await boardLink.count()) {
  await boardLink.click();
  await page.waitForTimeout(1400);
  boardNote = `点击白板 ${await page.evaluate(() => location.hash)}`;
}
await capture('05-trace-board', boardNote);
results.at(-1).calls = callsSince(boardStart);

// 4 规则列表 → 原文
start = mark();
await page.evaluate(() => { location.hash = '#/rules'; });
await page.waitForSelector('[data-role="rows"] tr', { timeout: 15000 }).catch(() => {});
await capture('06-rules');
results.at(-1).calls = callsSince(start);

const ruleStart = mark();
const ruleLink = page.locator('a[href^="#/rules/"]').first();
let ruleNote = '无规则链接';
if (await ruleLink.count()) {
  await ruleLink.click();
  await page.waitForTimeout(1400);
  ruleNote = `点击规则 ${await page.evaluate(() => location.hash)}`;
}
await capture('07-rule-detail', ruleNote);
results.at(-1).calls = callsSince(ruleStart);

// 5 知识库列表 → 条目
start = mark();
await page.evaluate(() => { location.hash = '#/knowledge'; });
await page.waitForSelector('[data-role="rows"] tr', { timeout: 15000 }).catch(() => {});
await capture('08-knowledge-list');
results.at(-1).calls = callsSince(start);

const entryStart = mark();
let entryNote = '无知识条目';
const firstRow = page.locator('[data-role="rows"] tr').first();
if (await firstRow.count()) {
  await firstRow.click();
  await page.waitForTimeout(1400);
  entryNote = '点击第一条知识条目（页内进入条目视图）';
}
await capture('09-knowledge-entry', entryNote);
results.at(-1).calls = callsSince(entryStart);

const summary = {
  base, generated_at: new Date().toISOString(), page_errors: pageErrors, console_errors: consoleErrors,
  pages: results.map(item => ({ ...item, api_ok: item.calls.filter(call => call.status >= 200 && call.status < 300).length }))
};
await writeFile(path.join(out, 'network.json'), JSON.stringify(summary, null, 1));
await browser.close();
console.log(JSON.stringify(summary.pages.map(page => ({ name: page.name, hash: page.hash,
  calls: page.calls.length, ok: page.api_ok, statuses: [...new Set(page.calls.map(c => c.status))],
  interaction: page.interaction })), null, 1));
