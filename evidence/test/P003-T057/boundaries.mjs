// P003-T057 边界/错误码用例（黑盒：只按 docs/modules/prompt-store.md 的承诺造调用）
// 用法：cd <tree> && node evidence/test/P003-T057/boundaries.mjs <工作目录>
// 输出一律是「CASE<n> <键=值 ...>」形式，由 tester-acceptance.sh 逐条断言。
// 判据出处全部在 docs/modules/prompt-store.md 的 §4.1 / §4.3 / §6.2 / §9。
import fs from 'node:fs/promises';
import path from 'node:path';

const work = process.argv[2] ?? '/tmp/t057-bnd';
const {PromptStore} = await import('file://' + path.resolve(process.cwd(), 'prompt-store.js'));

const rel = {
  version: 'demo-x', sequence: 1, title: 't', summary: 's',
  date: '2026-11-20', modules: [], changes: {},
};

const mk = async (name) => {
  const file = path.join(work, name + '.json');
  await fs.rm(file, {force: true});
  return file;
};
const show = (name, e) => `status=${String(e.status)} message=${e.message}`;

await fs.mkdir(work, {recursive: true});

// CASE1 §6.2/§6.3：22 个真键整包安装 → 装上，顶层 24 键（22 章节 + _release + _history）
{
  const st = new PromptStore(await mk('case1'));
  const snap = await st.snapshot();
  const cur = await st.load();
  const after = await st.install({...snap.sections}, rel, cur.revision, snap.knowledge_revision);
  const raw = JSON.parse(await fs.readFile(path.join(work, 'case1.json'), 'utf8'));
  console.log(`CASE1 ok version=${after.version} topkeys=${Object.keys(raw).length} history=${raw._history.length} sections=${Object.keys(snap.sections).length}`);
}

// CASE2 §6.2 第 3 条：22 个键全换名（键数不变）→ 400
{
  const st = new PromptStore(await mk('case2'));
  const snap = await st.snapshot();
  const cur = await st.load();
  const renamed = Object.fromEntries(Object.keys(snap.sections).map((_, i) => ['other:' + i, '正文']));
  try { await st.install(renamed, rel, cur.revision, snap.knowledge_revision); console.log('CASE2 ok 装上了（与文档不符）'); }
  catch (e) { console.log(`CASE2 err ${show('', e)}`); }
}

// CASE3 §6.2 第 3 条：少一个章节（21 个真键）→ 400
{
  const st = new PromptStore(await mk('case3'));
  const snap = await st.snapshot();
  const cur = await st.load();
  const cut = {...snap.sections};
  delete cut[Object.keys(cut)[0]];
  try { await st.install(cut, rel, cur.revision, snap.knowledge_revision); console.log('CASE3 ok 装上了（与文档不符）'); }
  catch (e) { console.log(`CASE3 err ${show('', e)}`); }
}

// CASE4 §6.2 第 1 条：expectedRevision 不符 → 409
{
  const st = new PromptStore(await mk('case4'));
  const snap = await st.snapshot();
  try { await st.install({...snap.sections}, rel, 'deadbeefdeadbeef', snap.knowledge_revision); console.log('CASE4 ok 装上了（与文档不符）'); }
  catch (e) { console.log(`CASE4 err ${show('', e)}`); }
}

// CASE5 §6.2 第 2 条：knowledgeRevision 不符 → 409
{
  const st = new PromptStore(await mk('case5'));
  const snap = await st.snapshot();
  const cur = await st.load();
  try { await st.install({...snap.sections}, rel, cur.revision, 'deadbeefdeadbeef'); console.log('CASE5 ok 装上了（与文档不符）'); }
  catch (e) { console.log(`CASE5 err ${show('', e)}`); }
}

// CASE6 §6.2 第 4 条 / R-PROMPT-04：sequence 等于当前值 → 409
{
  const st = new PromptStore(await mk('case6'));
  const snap = await st.snapshot();
  const cur = await st.load();
  await st.install({...snap.sections}, rel, cur.revision, snap.knowledge_revision);
  const snap2 = await st.snapshot();
  const cur2 = await st.load();
  try { await st.install({...snap2.sections}, rel, cur2.revision, snap2.knowledge_revision); console.log('CASE6 ok 同序号又装上了（与文档不符）'); }
  catch (e) { console.log(`CASE6 err ${show('', e)}`); }
}

// CASE7 §4.3 / §6.4：白名单「7 个核心键 + 13 个 scenario 键（共 20 个）」逐个收；
// 逐个断言 update() 返回值里对应章节被换掉。
{
  const st = new PromptStore(await mk('case7'));
  const snap = await st.snapshot();
  const keys = Object.keys(snap.sections).filter(k => !k.startsWith('sop:'));
  const core = keys.filter(k => !k.includes(':'));
  const scen = keys.filter(k => k.startsWith('scenario:'));
  let okCount = 0;
  for (const k of keys) {
    const cur = await st.load();
    const after = await st.update(k, '规则正文替换测试-' + k, cur.revision);
    const slot = k.startsWith('scenario:') ? after.scenarios.cards.find(c => 'scenario:' + c.id === k)?.prompt : after.prompts[k];
    if (slot === '规则正文替换测试-' + k) okCount++;
  }
  const final = await st.load();
  console.log(`CASE7 ok accepted=${okCount} whitelist_keys=${keys.length} core=${core.length} scenario=${scen.length} rule=${final.prompts.rule}`);
}

// CASE8 §4.3 / R-PROMPT-03：SOP 键不在白名单 → 普通 Error、无 status
{
  const st = new PromptStore(await mk('case8'));
  const cur = await st.load();
  try { await st.update('sop:common', '试图局部改写 SOP', cur.revision); console.log('CASE8 ok 收了（与文档不符）'); }
  catch (e) { console.log(`CASE8 err ${show('', e)}`); }
}

// CASE9 R-PROMPT-09 / §4.3：正文 20001 字 → 普通 Error、无 status
{
  const st = new PromptStore(await mk('case9'));
  const cur = await st.load();
  try { await st.update('triage', 'x'.repeat(20001), cur.revision); console.log('CASE9 ok 收了（与文档不符）'); }
  catch (e) { console.log(`CASE9 err ${show('', e)}`); }
}

// CASE10 §4.1：覆盖文件不是合法 JSON → SyntaxError，不吞
{
  const file = await mk('case10');
  await fs.writeFile(file, '{not json');
  const st = new PromptStore(file);
  try { await st.load(); console.log('CASE10 ok 吞了（与文档不符）'); }
  catch (e) { console.log(`CASE10 err name=${e.name} status=${String(e.status)}`); }
}
