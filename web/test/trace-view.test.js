// src/trace-view.js —— 溯源两页共用的展示口径：状态四词、种类六词、时间、短标识、错误一句话
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeTraceError, eventTypeLabel, formatClock, formatStamp, kindLabel, shortBoardId, statusClass, statusLabel,
} from '../src/trace-view.js';

test('状态四词照 D015：进行中 / 已完成 / 失败 / 中断；枚举外的原值照显示，空值给「—」', () => {
  assert.deepEqual(
    ['running', 'done', 'failed', 'interrupted'].map(statusLabel),
    ['进行中', '已完成', '失败', '中断']);
  assert.equal(statusLabel('paused'), 'paused');
  assert.equal(statusLabel(null), '—');
});

test('状态色点类：running / done / failed 各一档，interrupted 走默认', () => {
  assert.equal(statusClass('running'), 'is-running');
  assert.equal(statusClass('done'), 'is-done');
  assert.equal(statusClass('failed'), 'is-failed');
  assert.equal(statusClass('interrupted'), '');
});

test('种类六词照 D016：告警 / 主机 / 进程 / 文件 / 账号 / 请求；未知种类原样', () => {
  assert.deepEqual(
    ['alert', 'host', 'process', 'file', 'account', 'request'].map(kindLabel),
    ['告警', '主机', '进程', '文件', '账号', '请求']);
  assert.equal(kindLabel('unknown_kind'), 'unknown_kind');
  assert.equal(kindLabel(undefined), '—');
});

test('事件类型中文名与后端 eventTypes 对齐；未知类型原样；空值给 null 由调用方兜底', () => {
  assert.equal(eventTypeLabel('revshell'), '反弹 Shell');
  assert.equal(eventTypeLabel('honeypot'), '蜜罐');
  assert.equal(eventTypeLabel('brand_new'), 'brand_new');
  assert.equal(eventTypeLabel(null), null);
});

test('时间：坏值给「—」/ 空串，不编时间', () => {
  assert.equal(formatStamp(null), '—');
  assert.equal(formatStamp('not a date'), '—');
  assert.match(formatStamp('2026-11-17T02:00:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatClock(''), '');
  assert.match(formatClock('2026-11-17T02:00:00.000Z'), /^\d{2}:\d{2}:\d{2}$/);
});

test('短标识：短的原样，长的留首尾（完整 ID 由 title / href 保留）', () => {
  assert.equal(shortBoardId('revshell:1'), 'revshell:1');
  const long = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
  const short = shortBoardId(long);
  assert.ok(short.length < long.length);
  assert.ok(short.endsWith(long.slice(-8)));
  assert.equal(shortBoardId(null), '');
});

test('错误归一：六种 kind 各一句人能读的话，http 带状态码', () => {
  assert.match(describeTraceError({ kind: 'unauthorized' }), /登录已失效/);
  assert.match(describeTraceError({ kind: 'unavailable', message: '深度溯源尚未配置' }), /尚未配置/);
  assert.match(describeTraceError({ kind: 'notfound' }), /还没有溯源白板/);
  assert.match(describeTraceError({ kind: 'network' }), /连不上研判服务/);
  assert.match(describeTraceError({ kind: 'invalid' }), /形状不对/);
  assert.match(describeTraceError({ kind: 'http', status: 422, message: '没有可用资产' }), /422.*没有可用资产/);
});
