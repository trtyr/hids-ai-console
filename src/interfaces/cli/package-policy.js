import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptStore } from '../../contexts/knowledge/infrastructure/prompt-store.js';
import { log } from '../../shared/logging/log.js';
import { sealPackage } from '../../contexts/dataops/infrastructure/update-store.js';

const usage = '生成密钥：node package-policy.js --init-keys <内部密钥目录>\n制作更新包：node package-policy.js <公开更新说明.json> <输出.hids-policy>\n密钥路径与环境标识通过 HIDS_UPDATE_* 环境变量提供。';
const keyFiles = ['signing-private.pem', 'signing-public.pem', 'encryption.key'];

// 命令行拆成可调用的三步：main 只按参数分派。打印一律走 log.js（本文件不再自带打印）。
// 事件名见 docs/architecture.md「日志」一节；密钥内容与 HIDS_UPDATE_* 的取值一律不进日志。
export async function initKeys(directory) {
  const target = path.resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  for (const [name, content] of [
    ['signing-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['signing-public.pem', publicKey.export({ type: 'spki', format: 'pem' })],
    ['encryption.key', randomBytes(32)]
  ]) await writeFile(path.join(target, name), content, { mode: 0o600, flag: 'wx' });
  log('policy.keys_created', { directory: target, files: keyFiles,
    message: '密钥已创建。签名私钥只留在内部，不交付客户服务器。' });
}

export async function buildPackage(notesFile, output, env = process.env) {
  if (!output.endsWith('.hids-policy')) throw new Error('输出文件须使用 .hids-policy 扩展名');
  for (const key of ['HIDS_UPDATE_KEY_FILE','HIDS_UPDATE_PRIVATE_KEY_FILE','HIDS_UPDATE_TARGET'])
    if (!env[key]) throw new Error('缺少 '+key);
  const notes = JSON.parse(await readFile(notesFile, 'utf8'));
  const snapshot = await new PromptStore().snapshot();
  const payload = { type:'hids-prompts', api_version:1, target:env.HIDS_UPDATE_TARGET,
    version:notes.version, sequence:notes.sequence, date:notes.date, title:notes.title,
    summary:notes.summary, changes:notes.changes, ...snapshot };
  const encryptionKey = await readFile(env.HIDS_UPDATE_KEY_FILE);
  const privateKey = createPrivateKey(await readFile(env.HIDS_UPDATE_PRIVATE_KEY_FILE));
  if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('签名私钥必须为 Ed25519');
  const encoded = sealPackage(payload,{encryptionKey,privateKey});
  await writeFile(output, encoded, { mode:0o600, flag:'wx' });
  log('policy.package_built', { output, version: notes.version, sequence: notes.sequence,
    target: env.HIDS_UPDATE_TARGET, message: '已生成加密签名策略包；请通过维护端上传，核对详情后应用。' });
}

// 返回退出码而不是直接写 process.exitCode：main 被测试调用时不污染测试进程的退出码。
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === '--init-keys' && args.length === 2) { await initKeys(args[1]); return 0; }
  if (args.length === 2) { await buildPackage(args[0], args[1], env); return 0; }
  log('policy.usage', { message: usage }, 'error');
  return 1;
}

// 照 maintenance-server.js:172 的写法：被 import（测试）时不执行，只有直接跑才走命令行。
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code) process.exitCode = code;
}
