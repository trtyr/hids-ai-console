// src/credentials.js —— 凭据只在内存、Authorization 头的 base64 要按 UTF-8
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizationHeader,
  base64,
  clearCredentials,
  getCredentials,
  hasCredentials,
  setCredentials,
} from '../src/credentials.js';

test('base64：ASCII 与 UTF-8 中文都按 RFC 7617 的 UTF-8 字节编码', () => {
  assert.equal(base64('hids:hids-2026'), 'aGlkczpoaWRzLTIwMjY=');
  // 三个字节以下的两组补位分支
  assert.equal(base64('a'), 'YQ==');
  assert.equal(base64('ab'), 'YWI=');
  assert.equal(base64('abc'), 'YWJj');
  // 中文（3 字节/字）——错实现用 btoa(str) 会抛 InvalidCharacterError 或编出乱码
  assert.equal(base64('值守'), Buffer.from('值守', 'utf8').toString('base64'));
});

test('没有凭据时 authorizationHeader 为 null（别发一个空 Basic）', () => {
  clearCredentials();
  assert.equal(hasCredentials(), false);
  assert.equal(authorizationHeader(), null);
});

test('set → get → authorizationHeader；clear 之后全部清空', () => {
  setCredentials({ user: 'hids', password: 'p@ss :word' });
  assert.equal(hasCredentials(), true);
  assert.deepEqual(getCredentials(), { user: 'hids', password: 'p@ss :word' });
  assert.equal(authorizationHeader(), `Basic ${base64('hids:p@ss :word')}`);

  clearCredentials();
  assert.equal(hasCredentials(), false);
  assert.equal(getCredentials(), null);
  assert.equal(authorizationHeader(), null);
});
