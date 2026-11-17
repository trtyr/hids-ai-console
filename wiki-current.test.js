import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PromptStore } from './prompt-store.js';
import { WikiStore } from './wiki-store.js';

test('current scene prompts and agent indexes use reviewed criteria', async () => {
  const prompts = await new PromptStore(path.join(tmpdir(), `hids-no-overrides-${randomUUID()}.json`)).load();
  const wiki = new WikiStore();
  const expected = {
    webshell: 'WS-13', memory_webshell: 'MW-08', memory_security: 'RP-09', revshell: 'RS-09',
    suspicious_operation: 'SC-15', command_session: 'CA-08', malware: 'MA-09', brute_force: 'BF-10',
    honeypot: 'HP-10', elevation_process: 'LP-10', abnormal_login: 'AL-11', network_audit: 'NA-09'
  };
  for (const [eventType, criterion] of Object.entries(expected)) {
    assert.match(prompts.sop[eventType], new RegExp(`^id: ${criterion}$`, 'm'), eventType);
    const index = await wiki.agentIndex(eventType);
    assert.deepEqual(index.pages.map(page => page.id).sort(), ['GEN-12', criterion].sort(), eventType);
    const context = await wiki.agentContextPages(eventType);
    assert.deepEqual(context.map(page => page.id).sort(), ['GEN-12', criterion].sort(), eventType);
    assert.ok(context.every(page => page.content.length > 100), eventType);
    assert.match((await wiki.agentPage(eventType, criterion)).content, /结论/);
  }
  assert.match(prompts.sop.common, /行为、执行结果和授权范围/);
});
