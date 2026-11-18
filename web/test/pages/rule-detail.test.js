// pages/rule-detail.js —— 规则原文页（P003-T017）：A2「点开是这段 Rego，不是 JSON，不是表单」+ A3「不能编辑」+ 六格
// 接口形状：GET /api/rules/{id} → { id, name, description, file, rego }（openapi.yaml:664-684）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { mountRuleDetailPage } from '../../pages/rule-detail.js';
import { RegoRulesError, describeRegoRulesError } from '../../src/rego-rules.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { flush, setupDom, text } from '../dom.js';

beforeEach(() => {
  setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

/** 真接口形状：一份 .rego 原文（含注释、空行、缩进，逐字返回） */
const SOURCE = `package hids.rules.ssh_bruteforce

# name: SSH 暴力破解来源
# description: 登录类告警里来源 IP 非空、命令含 ssh 的

default match := false

match if {
  input.type == "abnormal_login"
  input.source_ip != ""
  contains(input.command, "ssh")
}
`;

const rule = (overrides = {}) => ({
  id: 'ssh_bruteforce', name: 'SSH 暴力破解来源',
  description: '登录类告警里来源 IP 非空、命令含 ssh 的', file: 'ssh_bruteforce.rego',
  rego: SOURCE, ...overrides,
});

const respond = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

function mountWith(replies, id = 'ssh_bruteforce') {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(String(url), init);
    return next;
  };
  const host = mountRuleDetailPage(id, { fetchImpl });
  document.body.append(host);
  return { host, calls };
}

const $ = (host, role) => host.querySelector(`[data-role="${role}"]`);

// ---------- A2：点开是这段 Rego，不是 JSON，不是表单 ----------

test('A2：原文逐字进 <pre>——含注释、空行、缩进，一个字节不裁剪', async () => {
  const { host, calls } = mountWith([respond(rule())]);
  await flush();
  const pre = $(host, 'rego');
  assert.equal(pre.tagName, 'PRE');
  assert.equal(pre.textContent, SOURCE);
  assert.equal(pre.textContent.split('\n').length, SOURCE.split('\n').length);
  assert.match(pre.textContent, /^package hids\.rules\.ssh_bruteforce\n/);
  assert.match(pre.textContent, /# name: SSH 暴力破解来源/);
  assert.equal(calls[0].url, '/api/rules/ssh_bruteforce');
});

test('A2：不是 JSON 视图——页面上没有 JSON 文本域，也没有表单', async () => {
  const { host } = mountWith([respond(rule())]);
  await flush();
  assert.equal(host.querySelector('textarea'), null, '原文是 <pre>，不是文本域');
  assert.equal(host.querySelector('form'), null);
  assert.equal(host.querySelector('[data-role="gutter"]'), null, '没有 JSON 视图的行号栏');
});

test('A2：上面是名字和这句话在放行什么，下面是原文（顺序照 D017）', async () => {
  const { host } = mountWith([respond(rule())]);
  await flush();
  assert.equal(text($(host, 'name')), 'SSH 暴力破解来源');
  assert.equal(text($(host, 'what')), rule().description);
  const html = host.innerHTML;
  assert.ok(html.indexOf('SSH 暴力破解来源') < html.indexOf('package hids.rules.ssh_bruteforce'), '名字在原文上面');
});

// ---------- A3：这轮页面上不能编辑 ----------

test('A3：整页没有可编辑控件（input / textarea / select / contenteditable 全无，原文不可改）', async () => {
  const { host } = mountWith([respond(rule())]);
  await flush();
  assert.equal(host.querySelector('input, textarea, select, [contenteditable]'), null);
  assert.equal($(host, 'rego').getAttribute('contenteditable'), null);
  assert.equal(host.querySelector('button[type="submit"]'), null);
  for (const label of ['保存', '编辑', '提交', '删除', '新增']) {
    assert.equal(host.textContent.includes(label), false, `页面上不该出现「${label}」`);
  }
});

// ---------- 页面上的其它字段 ----------

test('id 与文件名照接口显示；返回列表是去 `#/rules` 的真链接', async () => {
  const { host } = mountWith([respond(rule())]);
  await flush();
  assert.equal(text($(host, 'rule-id')), 'ssh_bruteforce');
  assert.match(text($(host, 'file')), /ssh_bruteforce\.rego/);
  assert.equal(host.querySelector('.back-link').getAttribute('href'), '#/rules');
});

test('description 为 null：写「这条规则没写一句话说明」，不编一句话', async () => {
  const { host } = mountWith([respond(rule({ description: null }))]);
  await flush();
  assert.equal(text($(host, 'what')), '这条规则没写一句话说明。');
  assert.equal($(host, 'what').classList.contains('is-muted'), true);
});

test('id 里的特殊字符会编码（页面不能拼裸串）', async () => {
  const { calls } = mountWith([respond({ error: '规则 id 无效' }, 400)], 'a b');
  await flush();
  assert.equal(calls[0].url, '/api/rules/a%20b');
});

// ---------- 六格状态矩阵 ----------

test('格 1 loading：原文区标 aria-busy、标题写正在读取、刷新禁用', async () => {
  const pending = new Promise(() => {});
  const { host } = mountWith([async () => pending]);
  await flush();
  assert.equal($(host, 'rego-wrap').getAttribute('aria-busy'), 'true');
  assert.equal(text($(host, 'name')), '正在读取规则…');
  assert.equal($(host, 'refresh').disabled, true);
});

test('格 2 empty（404）：写「规则库里已没有这条」，给回列表的出口，不摆读不出来的重试', async () => {
  const { host } = mountWith([respond({ error: '规则不存在' }, 404)], 'gone_rule');
  await flush();
  const block = host.querySelector('.page-error');
  assert.equal(text(block.querySelector('strong')), '规则库里已没有这条');
  assert.match(text(block), /gone_rule/);
  assert.equal(block.querySelector('a').getAttribute('href'), '#/rules');
  assert.equal(block.querySelector('button'), null, '库里没有这条，重试没有意义');
  assert.equal($(host, 'head').hidden, true, '不拿上一次的标题和原文垫在上面');
});

test('格 3 partial：刷新失败时挂提示，原文一个字都不清', async () => {
  const { host } = mountWith([respond(rule()), respond({ error: '连接不上' }, 502)]);
  await flush();
  $(host, 'refresh').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal($(host, 'notice').hidden, false);
  assert.match(text($(host, 'notice')), /连接不上/);
  assert.equal($(host, 'rego').textContent, SOURCE);
});

test('格 4 error：首次就 502——整块失败写服务端原话（带 rules/<文件>:<行>），重试成功后出原文', async () => {
  const message = '规则库读取失败：rules/ssh_bruteforce.rego:3: 缺少 # name: 显示名';
  const { host, calls } = mountWith([respond({ error: message }, 502), respond(rule())]);
  await flush();
  const block = host.querySelector('.page-error');
  assert.equal(text(block.querySelector('strong')), '规则原文读取失败');
  assert.match(text(block), /rules\/ssh_bruteforce\.rego:3/);

  block.querySelector('.btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(host.querySelector('.page-error'), null);
  assert.equal($(host, 'rego').textContent, SOURCE);
});

test('格 4 error：401 文案是「登录已失效」', async () => {
  const { host } = mountWith([respond({ error: '需要登录后访问' }, 401)]);
  await flush();
  assert.match(text(host.querySelector('.page-error')), /登录已失效/);
});

test('格 5 long-content：200 行的 Rego 全文进 DOM（不在数据层截断，长了由样式在块内滚）', async () => {
  const long = `package hids.rules.big\n# name: 很长的一条规则\n\nmatch if {\n${Array.from({ length: 200 }, (_, i) => `  input.type == "t${i}"`).join('\n')}\n}\n`;
  const { host } = mountWith([respond(rule({ id: 'big', name: '很长的一条规则', rego: long }))], 'big');
  await flush();
  const pre = $(host, 'rego');
  assert.equal(pre.textContent, long);
  assert.equal(pre.textContent.split('\n').length, 206);
});

test('格 6 disabled：请求在飞时刷新禁用且转圈，读完恢复', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { host } = mountWith([async () => {
    await gate;
    return respond(rule());
  }]);
  await flush();
  assert.equal($(host, 'refresh').disabled, true);
  assert.equal($(host, 'refresh').classList.contains('is-loading'), true);

  release();
  await flush();
  assert.equal($(host, 'refresh').disabled, false);
  assert.equal($(host, 'refresh').classList.contains('is-loading'), false);
});

// ---------- 错误文案 ----------

test('describeRegoRuleError：四类 kind 各说各的，http 用服务端原话', () => {
  assert.equal(describeRegoRulesError(new RegoRulesError('unauthorized', '登录已失效，请重新登录')), '登录已失效，请重新登录。');
  assert.equal(describeRegoRulesError(new RegoRulesError('network', '连接不上研判服务')), '连接不上研判服务。');
  assert.equal(describeRegoRulesError(new RegoRulesError('invalid', 'x')), '规则接口返回的形状不对。');
  assert.equal(describeRegoRulesError(new RegoRulesError('http', '规则库读取失败：rules/a.rego:1: 缺少 package')), '规则库读取失败：rules/a.rego:1: 缺少 package');
  assert.equal(describeRegoRulesError(new Error('别的东西')), '别的东西');
});
