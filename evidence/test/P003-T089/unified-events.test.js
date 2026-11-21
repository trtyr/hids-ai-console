// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import。
import { assertIsolatedRoot } from '../P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../../server.js';
import { TriageMonitor } from '../../../src/contexts/triage/application/triage-monitor.js';

test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// 读到指定条数的事件帧后主动断开（不让用例挂着）。
async function readFrames(base, query, wanted, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames = [];
  try {
    const response = await fetch(`${base}/api/events${query}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (frames.length < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6)));
      }
    }
    controller.abort();
  } catch (error) { if (error.name !== 'AbortError') throw error; }
  clearTimeout(timer);
  return frames;
}

test('T089 统一 SSE：一条连接推四类快照，事件格式恒为 {type, topic, at}', async t => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t089.json', service: {}, investigator: {}, history: {}, concurrency: 0 });
  // boardService 用最小替身（running 是 Map）：生产里没配白板服务时 board 快照按设计跳过。
  const boardStub = { running: new Map() };
  const base = await listen(t, createServer(null, null, null, null, null, monitor, null, null, boardStub));
  const frames = await readFrames(base, '?topics=triage,board,investigation,fp', 4);
  assert.ok(frames.length >= 4, `至少四帧快照，实测 ${frames.length}`);
  for (const frame of frames) {
    assert.equal(typeof frame.type, 'string');
    assert.equal(typeof frame.topic, 'string');
    assert.match(frame.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const topics = frames.map(frame => frame.topic).sort();
  assert.deepEqual(topics, ['board', 'fp', 'investigation', 'triage']);
  const triage = frames.find(frame => frame.topic === 'triage');
  assert.equal(triage.type, 'snapshot');
  assert.equal(triage.configured, true);
  assert.deepEqual(triage.counts, { queued: 0, running: 0, done: 0, failed: 0 });
});

test('T089 统一 SSE：topic 与 interval_ms 校验；只订一个 topic 就只推那一个', async t => {
  const base = await listen(t, createServer(null, null, null, null, null, null));
  assert.equal((await fetch(`${base}/api/events?topics=nope`)).status, 400);
  assert.equal((await fetch(`${base}/api/events?interval_ms=100`)).status, 400);
  assert.equal((await fetch(`${base}/api/events?interval_ms=999999`)).status, 400);
  const frames = await readFrames(base, '?topics=fp', 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].topic, 'fp');
  assert.equal(frames[0].running, 0);
});

test('T089 统一 SSE：队列状态变化推 progress 帧', async t => {
  const monitor = new TriageMonitor({ file: '/tmp/hids-t089b.json', service: {}, investigator: {}, history: {}, concurrency: 0 });
  const base = await listen(t, createServer(null, null, null, null, null, monitor));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const frames = [];
  try {
    const response = await fetch(`${base}/api/events?topics=triage&interval_ms=500`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 收到快照后入队一条，等 progress
    while (frames.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (chunk.startsWith('data: ')) {
          const frame = JSON.parse(chunk.slice(6));
          frames.push(frame);
          if (frames.length === 1) await monitor.enqueue('honeypot:7');
        }
      }
    }
    controller.abort();
  } catch (error) { if (error.name !== 'AbortError') throw error; }
  clearTimeout(timer);
  assert.ok(frames.length >= 2, `应有快照 + 变化帧，实测 ${frames.length}`);
  assert.equal(frames[0].type, 'snapshot');
  const progress = frames.find(frame => frame.type === 'progress');
  assert.ok(progress, '入队后应推 progress');
  assert.equal(progress.topic, 'triage');
  assert.ok(progress.counts.queued + progress.counts.running >= 1);
});
