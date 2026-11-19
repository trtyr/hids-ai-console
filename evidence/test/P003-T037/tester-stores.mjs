// P003-T037 tester probe: A6 RuleStore mtime 缓存、A7 Wiki 目录索引 mtime 缓存
// 黑盒：缓存键=（mtimeMs, size）由 docs/modules/investigation-agent.md:478-480 与
//       docs/modules/knowledge-base.md:111-118 写明；"同一毫秒内改写且字节数不变要等下一次 mtime 变化"是文档写明的代价
import { cp, copyFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleStore } from '../../../rule-store.js';

let pass = 0; const fails = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔', label); }
  else { fails.push(label + (detail ? ' | ' + detail : '')); console.log('  ✖', label, detail); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);
const base = await mkdtemp(join(tmpdir(), 't37-stores-'));
const repoRules = new URL('../../../rules/', import.meta.url).pathname;

console.log('== A6 RuleStore：同 (mtimeMs,size) 不重解析 ==');
{
  const dir = join(base, 'rules');
  await rm(dir, { recursive: true, force: true });
  await cp(repoRules, dir, { recursive: true });
  const store = new RuleStore(dir);
  const first = await store.list();
  eq(first.count, 3, '三份规则全部解析成功');
  const target = join(dir, 'honeypot_probe.rego');
  const st = await stat(target);
  const original = await readFile(target);              // .rego 是随部署的规则数据，不是被测实现
  const junk = Buffer.alloc(st.size, 0x20);             // 同字节数的非法内容
  junk.write('not a rego file', 0);
  await writeFile(target, junk);
  await utimes(target, st.atimeMs / 1000, st.mtimeMs / 1000);
  const afterCorruptSameMtime = await store.list();
  eq(afterCorruptSameMtime.count, 3, '(mtimeMs,size) 未变：非法内容未重解析（走缓存）');
  eq((await stat(target)).size, original.length, '探针自身守住同字节数前提');
  await utimes(target, new Date(), new Date());
  let err = null;
  try { await store.list(); } catch (e) { err = e; }
  ok(!!err, 'mtime 变了：非法内容被重新解析并报错', err ? '' : '未报错');
  await copyFile(join(repoRules, 'honeypot_probe.rego'), target);
  await utimes(target, new Date(), new Date());
  eq((await store.list()).count, 3, '恢复合法内容 + mtime 变化：解析恢复');
}
console.log('== A6 RuleStore：新增 / 删除立刻可见 ==');
{
  const dir = join(base, 'rules2');
  await rm(dir, { recursive: true, force: true });
  await cp(repoRules, dir, { recursive: true });
  const store = new RuleStore(dir);
  eq((await store.list()).count, 3, '初始 3 条');
  await copyFile(join(dir, 'honeypot_probe.rego'), join(dir, 'zz_extra.rego'));
  let dupErr = null;
  try { await store.list(); } catch (e) { dupErr = e; }
  ok(/规则 id 重复：honeypot_probe/.test(dupErr?.message || ''), '同 id 新文件：报错口径不变（重复 id）', dupErr?.message);
  await rm(join(dir, 'zz_extra.rego'));
  const valid = (await readFile(join(dir, 'ssh_bruteforce.rego'), 'utf8')).replaceAll('ssh_bruteforce', 'zz_extra_probe');
  await writeFile(join(dir, 'zz_extra.rego'), valid);
  eq((await store.list()).count, 4, '新增不同 id 的文件：list() 立刻多一条');
  await rm(join(dir, 'zz_extra.rego'));
  await rm(join(dir, 'ssh_bruteforce.rego'));
  eq((await store.list()).count, 2, '删除文件后 list() 立刻少一条');
}

console.log('== A7 Wiki 目录索引：同签名不重读、mtime 变即生效 ==');
{
  const dir = join(base, 'wiki');
  await rm(dir, { recursive: true, force: true });
  await cp(new URL('../../../wiki/', import.meta.url).pathname, dir, { recursive: true });
  process.env.HIDS_WIKI_DIR = dir;            // wiki-store.js 在模块加载时读这个变量，必须先设再 import
  const { WikiStore } = await import('../../../wiki-store.js');
  const wiki = new WikiStore();
  const l1 = await wiki.list();
  ok(l1.length > 10, '目录索引非空', `len=${l1.length}`);
  const idx1 = await wiki.agentIndex('honeypot');
  const idx2 = await wiki.agentIndex('honeypot');
  eq(idx1, idx2, '同签名两次 agentIndex 结果一致');

  const page = join(dir, 'honeypot/HP-10.md');
  const st = await stat(page);
  const text = await readFile(page, 'utf8');
  const m = text.match(/title:\s*(.+)/);
  ok(!!m, '页面有 title 行');
  const oldTitle = m[1].trim();
  const last = [...oldTitle].pop();
  const repl = /[\u4e00-\u9fff]/.test(last) ? (last === '测' ? '试' : '测') : (last === 'a' ? 'b' : 'a');
  const newTitle = oldTitle.slice(0, -1) + repl;
  const mutated = text.replace(m[0], m[0].replace(oldTitle, newTitle));
  eq(Buffer.byteLength(mutated), Buffer.byteLength(text), '改写后字节数不变（探针前提）');
  await writeFile(page, mutated);
  await utimes(page, st.atimeMs / 1000, st.mtimeMs / 1000);
  const l2 = await wiki.list();
  const row2 = l2.find(r => r.path === 'honeypot/HP-10.md');
  eq(row2?.title, oldTitle, '(mtimeMs,size) 未变：标题改动看不到（缓存生效）');
  await utimes(page, new Date(), new Date());
  const l3 = await wiki.list();
  const row3 = l3.find(r => r.path === 'honeypot/HP-10.md');
  eq(row3?.title, newTitle, 'mtime 变：标题改动立刻生效');
  const idx3 = await wiki.agentIndex('honeypot');
  ok(JSON.stringify(idx3).includes(newTitle), 'agentIndex 同步看到新标题');

  await rm(page);
  const l4 = await wiki.list();
  eq(l4.length, l3.length - 1, '删除页面后目录索引立刻少一条');
  let idxErr = null;
  try { await wiki.agentIndex('nope_type'); } catch (e) { idxErr = e; }
  ok(!!idxErr, '未知类型照样抛错（报错口径不变）', idxErr?.message);
  delete process.env.HIDS_WIKI_DIR;
}

await rm(base, { recursive: true, force: true });
console.log(`\n== 汇总：pass ${pass} / fail ${fails.length} ==`);
if (fails.length) { for (const f of fails) console.log('FAIL:', f); process.exitCode = 1; }
