// pages/rules.js —— 前置规则页：六格状态矩阵 + 表单/JSON 双视图 + 校验 / 保存
// 字段一律照接口真名（openapi.yaml:851-857 的 RuleSetResponse / validate / PUT 回包）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { describeRulesError, mountRulesPage, pathLabel, pretty } from '../../pages/rules.js';
import { clearCredentials, setCredentials } from '../../src/credentials.js';
import { byRole, flush, setupDom, text } from '../dom.js';

let calls = [];

beforeEach(() => {
  setupDom();
  calls = [];
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
});

// ---------- 夹具 ----------

/** 真接口形状：GET /api/triage/rules（revision 取自示例文件时为 null，triage-rules.js:231） */
const ruleSet = (overrides = {}) => ({
  config: { schema_version: 1, enabled: true, rules: [{ id: 'RULE-03', event_type: 'revshell' }] },
  revision: 'a1b2c3d4e5f60718',
  writable: true,
  origin: 'file',
  ...overrides,
});

const respond = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** 按 method + 路径分派；handler 可以是回包对象，也可以是 (url, init) => 回包；没给的分支直接抛 */
function routes({ rules, validate, save } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const method = init.method ?? 'GET';
    const handler = method === 'GET' ? rules : String(url).endsWith('/validate') ? validate : save;
    if (!handler) throw new TypeError(`未预期的请求 ${method} ${url}`);
    return typeof handler === 'function' ? handler(url, init) : handler;
  };
}

async function mount(fetchImpl, extra = {}) {
  const host = mountRulesPage({ fetchImpl, ...extra });
  document.body.append(host);
  await flush();
  return host;
}

const region = () => document.querySelector('.rules-host');
const form = () => region().querySelector('[data-role="form"]');
const kind = role => region().querySelector(`[data-role="${role}"]`);
/** 顶层字段名（不含嵌套层里的 key 控件） */
const topKeys = () => [...form().children]
  .filter(node => node.classList.contains('form-row'))
  .map(row => row.querySelector('input[data-role="key"]').value);
const click = node => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const typeInto = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const pick = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event('change', { bubbles: true }));
};

// ---------- 纯函数 ----------

test('pretty / pathLabel / describeRulesError：给界面看的形状', () => {
  assert.equal(pretty({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(pathLabel(['rules', 0, 'id']), 'rules / 0 / id');
  assert.match(describeRulesError({ kind: 'network' }), /连不上研判服务/);
  assert.match(describeRulesError({ kind: 'conflict', message: '规则配置已变化，请刷新后重试' }), /刷新/);
  assert.equal(describeRulesError({ kind: 'http', status: 400, message: '规则集格式无效' }), '规则集格式无效');
});

// ---------- 页面契约 ----------

test('page.render：内容区只留一个根节点，编辑面板有可访问名', async () => {
  const { page } = await import('../../pages/rules.js');
  const content = document.createElement('div');
  page.render(content, { params: [] });
  await flush();
  assert.equal(content.children.length, 1);
  assert.ok(content.querySelector('section[aria-label="规则配置编辑器"]'));
  assert.ok(content.querySelector('aside[aria-label="规则操作"]'));
  assert.equal(page.id, 'rules');
  assert.equal(page.title, '规则');
  assert.equal(page.navLabel, '规则');
});

// ---------- 格 1：loading ----------

test('加载中：表单区说明在读取，按钮全禁用，区域标 aria-busy', async () => {
  const pending = new Promise(() => {});
  await mount(async () => pending);
  assert.match(text(form()), /正在读取规则配置/);
  assert.equal(text(kind('rev-value')), '—');
  assert.equal(byRole(region(), 'button', '保存规则').disabled, true);
  assert.equal(byRole(region(), 'button', '撤销修改').disabled, true);
  assert.equal(byRole(region(), 'button', '校验配置').disabled, true);
  assert.equal(kind('shell').getAttribute('aria-busy'), 'true');
});

// ---------- 格 2：空配置 ----------

test('空配置 {}：表单写空对象说明，revision 与可写照接口，未保存标记隐藏', async () => {
  await mount(routes({ rules: respond(ruleSet({ config: {}, revision: null, writable: false })) }));
  assert.match(text(form()), /当前 config 为空对象/);
  assert.equal(text(kind('rev-label')), '无 revision');
  assert.equal(text(kind('rev-value')), 'null');
  assert.equal(text(kind('expected-rev')), 'null');
  assert.equal(text(kind('writable-value')), '只读');
  assert.equal(text(kind('writable-badge')), '只读');
  assert.equal(kind('dirty').hidden, true);
  assert.equal(text(kind('count-value')), '未校验');
});

test('空配置也能进 JSON 视图：textarea 是 {}，行号 1 行', async () => {
  await mount(routes({ rules: respond(ruleSet({ config: {} })) }));
  click(byRole(region(), 'button', 'JSON'));
  assert.equal(kind('config').value, '{}');
  assert.equal(kind('gutter').textContent, '1');
  assert.equal(byRole(region(), 'button', 'JSON').getAttribute('aria-pressed'), 'true');
  assert.equal(byRole(region(), 'button', '表单').getAttribute('aria-pressed'), 'false');
});

// ---------- 表单渲染 ----------

test('表单按 config 递归生成：三个键、布尔勾选框、数组折叠头、嵌套对象折叠头', async () => {
  await mount(routes({
    rules: respond(ruleSet({
      config: {
        schema_version: 1,
        enabled: true,
        rules: [{ id: 'RULE-03', note: null }],
        extra: { nested: 'x' },
      },
    })),
  }));
  assert.deepEqual(topKeys(), ['schema_version', 'enabled', 'rules', 'extra']);
  const bool = form().querySelector('input[data-act="bool"]');
  assert.equal(bool.checked, true);
  const summaries = [...form().querySelectorAll('details > summary')].map(node => text(node));
  assert.ok(summaries.includes('数组 · 1 项'), `数组折叠头缺失：${summaries}`);
  assert.ok(summaries.includes('对象 · 1 个字段'), `对象折叠头缺失：${summaries}`);
  assert.equal(text(form().querySelector('.null-val')), 'null');
  // 数组默认展开、嵌套对象默认折叠（稿 §2）
  const [arrayDetails, objectDetails] = form().querySelectorAll('details');
  assert.equal(arrayDetails.open, true);
  assert.equal(objectDetails.open, false);
});

// ---------- 格 3：partial / 只读 ----------

test('只读（writable=false）：徽标只读、JSON 只读、表单控件禁用、保存禁用', async () => {
  await mount(routes({ rules: respond(ruleSet({ writable: false })) }));
  assert.equal(text(kind('writable-badge')), '只读');
  click(byRole(region(), 'button', 'JSON'));
  assert.equal(kind('config').readOnly, true);
  click(byRole(region(), 'button', '表单'));
  const inputs = [...form().querySelectorAll('input, select')];
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every(input => input.disabled), '只读时表单控件应全部 disabled');
  assert.equal(byRole(region(), 'button', '保存规则').disabled, true);
});

test('只读时点删除无效：模型不变', async () => {
  await mount(routes({ rules: respond(ruleSet({ writable: false })) }));
  click(byRole(region(), 'button', '删除字段 schema_version'));
  assert.deepEqual(topKeys(), ['schema_version', 'enabled', 'rules']);
  assert.equal(kind('dirty').hidden, true);
});

// ---------- 编辑 ----------

test('改值 → 未保存标记出现、撤销可用；填令牌后保存才可用', async () => {
  await mount(routes({ rules: respond(ruleSet()), save: respond({ config: {}, revision: 'f'.repeat(16) }) }));
  const valueInput = form().querySelector('input[aria-label="值 · schema_version"]');
  typeInto(valueInput, '2');
  assert.equal(kind('dirty').hidden, false);
  assert.equal(byRole(region(), 'button', '撤销修改').disabled, false);
  const save = byRole(region(), 'button', '保存规则');
  assert.equal(save.disabled, true, '没有令牌时不许保存');
  typeInto(kind('token'), 'tk-1');
  assert.equal(save.disabled, false);
});

test('字段名重复 / 为空被拒绝并记日志，原名保留', async () => {
  await mount(routes({ rules: respond(ruleSet()) }));
  const first = form().querySelector('input[data-role="key"]');
  pick(first, 'enabled');
  assert.match(text(kind('log')), /字段名不能为空或与已有字段重复/);
  assert.deepEqual(topKeys(), ['schema_version', 'enabled', 'rules']);
});

test('添加字段 / 添加一项 / 上移下移 / 删除项 都只改本地模型', async () => {
  await mount(routes({ rules: respond(ruleSet({ config: { rules: [{ id: 'A' }, { id: 'B' }] } })) }));
  const topAddRow = [...form().children].find(node => node.classList.contains('add-row'));
  topAddRow.querySelector('[data-role="new-key"]').value = 'enabled';
  pick(topAddRow.querySelector('[data-role="new-type"]'), 'boolean');
  click(topAddRow.querySelector('button'));
  // 交给 JSON 视图验证模型（表单是递归重绘的，逐层点太脆）
  click(byRole(region(), 'button', 'JSON'));
  assert.match(kind('config').value, /"enabled": false/);

  click(byRole(region(), 'button', '表单'));
  click(byRole(region(), 'button', '下移第 1 项'));
  click(byRole(region(), 'button', 'JSON'));
  const model = JSON.parse(kind('config').value);
  assert.deepEqual(model.rules.map(item => item.id), ['B', 'A']);

  click(byRole(region(), 'button', '表单'));
  click(byRole(region(), 'button', '删除第 1 项'));
  click(byRole(region(), 'button', 'JSON'));
  assert.deepEqual(JSON.parse(kind('config').value).rules.map(item => item.id), ['A']);
});

test('布尔勾选框切换会写回模型并同步 true/false 文案', async () => {
  await mount(routes({ rules: respond(ruleSet()) }));
  const bool = form().querySelector('input[data-act="bool"]');
  bool.checked = false;
  bool.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(text(form().querySelector('[data-role="bool-text"]')), 'false');
  click(byRole(region(), 'button', 'JSON'));
  assert.match(kind('config').value, /"enabled": false/);
});

// ---------- JSON 视图 ----------

test('JSON 视图：改文本即时解析，语法错误就地提示并挡住切回表单', async () => {
  await mount(routes({ rules: respond(ruleSet()) }));
  click(byRole(region(), 'button', 'JSON'));
  typeInto(kind('config'), '{ "schema_version": 1, ');
  assert.equal(kind('syntax').classList.contains('is-error'), true);
  assert.match(text(kind('syntax')), /JSON 语法错误/);
  click(byRole(region(), 'button', '表单'));
  assert.equal(kind('json-wrap').hidden, false, '语法错误时应停在 JSON 视图');
  assert.match(text(kind('syntax')), /修正后才能切回表单/);

  typeInto(kind('config'), '{"schema_version": 2}');
  assert.equal(kind('syntax').classList.contains('is-error'), false);
  click(byRole(region(), 'button', '表单'));
  assert.equal(kind('json-wrap').hidden, true);
  assert.deepEqual(topKeys(), ['schema_version']);
});

test('JSON 视图里 config 不是对象：切到表单后提示，且校验被拒', async () => {
  await mount(routes({ rules: respond(ruleSet()), validate: respond({ valid: true, count: 0 }) }));
  click(byRole(region(), 'button', 'JSON'));
  typeInto(kind('config'), '[1, 2]');
  click(byRole(region(), 'button', '表单'));
  assert.match(text(form()), /config 不是对象/);
  click(byRole(region(), 'button', '校验配置'));
  await flush();
  assert.match(text(kind('validate-result')), /config 必须是 JSON 对象/);
  assert.equal(calls.filter(call => call.url.endsWith('/validate')).length, 0, '不是对象时不该发校验请求');
});

// ---------- 校验 ----------

test('校验通过：条目数取接口 count，结果条标 ok', async () => {
  await mount(routes({ rules: respond(ruleSet()), validate: respond({ valid: true, count: 3 }) }));
  click(byRole(region(), 'button', '校验配置'));
  await flush();
  assert.match(text(kind('validate-result')), /校验通过 · 条目数 3/);
  assert.equal(kind('validate-result').classList.contains('is-ok'), true);
  assert.equal(text(kind('count-value')), '3');
  const posted = JSON.parse(calls.find(call => call.url.endsWith('/validate')).init.body);
  assert.deepEqual(posted, { config: ruleSet().config });
});

test('校验失败（400）：显示服务端原话，条目数回到 —', async () => {
  await mount(routes({ rules: respond(ruleSet()), validate: respond({ error: '规则集格式无效' }, 400) }));
  click(byRole(region(), 'button', '校验配置'));
  await flush();
  assert.match(text(kind('validate-result')), /校验失败：规则集格式无效/);
  assert.equal(kind('validate-result').classList.contains('is-error'), true);
  assert.equal(text(kind('count-value')), '—');
  assert.match(text(kind('log')), /校验失败/);
});

// ---------- 保存 ----------

test('保存成功：用接口返回的 revision，未保存标记消失，body 带 expected_revision', async () => {
  const saved = { config: { schema_version: 2 }, revision: 'b'.repeat(16), origin: 'file' };
  await mount(routes({ rules: respond(ruleSet()), save: respond(saved) }));
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '2');
  typeInto(kind('token'), 'tk-1');
  click(byRole(region(), 'button', '保存规则'));
  await flush();
  assert.match(text(kind('validate-result')), /已保存 · bbbbbbbbbbbbbbbb/);
  assert.equal(text(kind('rev-value')), 'b'.repeat(16));
  assert.equal(kind('dirty').hidden, true);
  assert.equal(kind('token').value, 'tk-1', '令牌是页面本地状态，保存后不清空');
  const put = calls.find(call => call.init.method === 'PUT');
  assert.deepEqual(JSON.parse(put.init.body), {
    config: { schema_version: 2, enabled: true, rules: [{ id: 'RULE-03', event_type: 'revshell' }] },
    expected_revision: ruleSet().revision,
  });
  assert.equal(put.init.headers['X-Rule-Admin-Token'], 'tk-1');
});

test('保存失败（403）：提示原话、编辑与未保存标记都保留', async () => {
  await mount(routes({ rules: respond(ruleSet()), save: respond({ error: '规则管理员令牌无效' }, 403) }));
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '2');
  typeInto(kind('token'), 'bad');
  click(byRole(region(), 'button', '保存规则'));
  await flush();
  assert.match(text(kind('validate-result')), /保存失败：规则管理员令牌无效/);
  assert.equal(kind('dirty').hidden, false);
  assert.equal(form().querySelector('input[aria-label="值 · schema_version"]').value, '2');
  assert.equal(text(kind('rev-value')), ruleSet().revision, '失败时 revision 不前进');
});

test('保存冲突（409）：文案带「刷新」，不丢编辑', async () => {
  await mount(routes({ rules: respond(ruleSet()), save: respond({ error: '规则配置已变化，请刷新后重试' }, 409) }));
  typeInto(kind('token'), 'tk');
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '9');
  click(byRole(region(), 'button', '保存规则'));
  await flush();
  assert.match(text(kind('validate-result')), /刷新后按新版本重编辑/);
  assert.equal(kind('dirty').hidden, false);
});

// ---------- 格 5：error（整页读取失败） ----------

test('读取失败：整块提示 + 重试；重试成功后提示消失', async () => {
  let attempt = 0;
  const flaky = async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError('fetch failed');
    return respond(ruleSet());
  };
  await mount(routes({ rules: flaky }));
  assert.equal(kind('error').hidden, false);
  assert.match(text(kind('error')), /连不上研判服务/);
  assert.match(text(form()), /点上方「重试」/);
  assert.equal(byRole(region(), 'button', '保存规则').disabled, true);

  click(byRole(region(), 'button', '重试'));
  await flush();
  assert.equal(kind('error').hidden, true);
  assert.deepEqual(topKeys(), ['schema_version', 'enabled', 'rules']);
});

test('读取失败 401：文案是「重新登录」，不是服务端纯文本正文', async () => {
  await mount(routes({ rules: respond({}, 401) }));
  assert.match(text(kind('error')), /登录已失效/);
});

test('刷新：丢弃未保存修改，重新读接口，结果条一并清掉', async () => {
  await mount(routes({ rules: respond(ruleSet()), save: respond({ error: '规则管理员令牌无效' }, 403) }));
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '7');
  typeInto(kind('token'), 'bad');
  click(byRole(region(), 'button', '保存规则'));
  await flush();
  assert.match(text(kind('validate-result')), /保存失败/);
  assert.equal(kind('dirty').hidden, false);

  click(byRole(region(), 'button', '刷新'));
  await flush();
  assert.equal(kind('dirty').hidden, true);
  assert.equal(form().querySelector('input[aria-label="值 · schema_version"]').value, '1');
  assert.equal(kind('validate-result').hidden, true, '刷新成功后旧的失败提示不该继续挂着');
  assert.match(text(kind('log')), /已重新读取规则配置/);
});

test('已有数据时刷新失败：不清屏、不丢编辑，只在结果条与日志报错', async () => {
  let attempt = 0;
  const flaky = async () => {
    attempt += 1;
    if (attempt === 1) return respond(ruleSet());
    throw new TypeError('fetch failed');
  };
  await mount(routes({ rules: flaky }));
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '7');
  click(byRole(region(), 'button', '刷新'));
  await flush();
  assert.equal(kind('error').hidden, true);
  assert.match(text(kind('validate-result')), /刷新失败：连不上研判服务/);
  assert.equal(kind('dirty').hidden, false);
});

// ---------- 撤销 / 复制 ----------

test('撤销修改：模型回到上次保存的快照', async () => {
  await mount(routes({ rules: respond(ruleSet()) }));
  typeInto(form().querySelector('input[aria-label="值 · schema_version"]'), '7');
  click(byRole(region(), 'button', '撤销修改'));
  assert.equal(form().querySelector('input[aria-label="值 · schema_version"]').value, '1');
  assert.equal(kind('dirty').hidden, true);
  assert.match(text(kind('log')), /已撤销未保存修改/);
});

test('复制 JSON：剪贴板拿到格式化文本；不支持时记一条错误日志', async () => {
  const copied = [];
  await mount(routes({ rules: respond(ruleSet()) }), { clipboard: { writeText: async value => { copied.push(value); } } });
  click(byRole(region(), 'button', '复制 JSON'));
  await flush();
  assert.deepEqual(JSON.parse(copied[0]), ruleSet().config);
  assert.match(text(kind('log')), /已复制到剪贴板/);

  setupDom();
  clearCredentials();
  setCredentials({ user: 'hids', password: 'hids-2026' });
  calls = [];
  await mount(routes({ rules: respond(ruleSet()) }), { clipboard: null });
  click(byRole(region(), 'button', '复制 JSON'));
  await flush();
  assert.match(text(kind('log')), /复制失败，请手动选择/);
});

// ---------- 格 6：long-content ----------

test('超长内容：深嵌套与长字符串照原样进控件，JSON 行号跟着行数走', async () => {
  const longText = 'x'.repeat(4000);
  const config = { a: { b: { c: { d: { e: longText } } } } };
  await mount(routes({ rules: respond(ruleSet({ config })) }));
  const nested = form().querySelectorAll('details');
  assert.equal(nested.length, 4, '四层嵌套对象都要有折叠头');
  click(byRole(region(), 'button', 'JSON'));
  assert.ok(kind('config').value.includes(longText));
  const lines = kind('config').value.split('\n').length;
  assert.equal(kind('gutter').textContent.split('\n').length, lines);
});

test('可访问性：值控件有可访问名，日志是 live region，编辑视图是按钮组', async () => {
  await mount(routes({ rules: respond(ruleSet()) }));
  const value = form().querySelector('input[aria-label="值 · schema_version"]');
  assert.equal(value.getAttribute('aria-label'), '值 · schema_version');
  assert.equal(kind('log').getAttribute('aria-live'), 'polite');
  const group = region().querySelector('[role="group"][aria-label="编辑视图"]');
  assert.ok(group);
  assert.equal(kind('sr-status').getAttribute('role'), 'status');
});
