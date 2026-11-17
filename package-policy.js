import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PromptStore } from './prompt-store.js';
import { sealPackage } from './update-store.js';

const args = process.argv.slice(2);
if (args[0] === '--init-keys' && args.length === 2) {
  const directory = path.resolve(args[1]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  for (const [name, content] of [
    ['signing-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['signing-public.pem', publicKey.export({ type: 'spki', format: 'pem' })],
    ['encryption.key', randomBytes(32)]
  ]) await writeFile(path.join(directory, name), content, { mode: 0o600, flag: 'wx' });
  console.log('密钥已创建。签名私钥只留在内部，不交付客户服务器。');
} else if (args.length === 2) {
  const [notesFile, output] = args;
  if (!output.endsWith('.hids-policy')) throw new Error('输出文件须使用 .hids-policy 扩展名');
  for (const key of ['HIDS_UPDATE_KEY_FILE','HIDS_UPDATE_PRIVATE_KEY_FILE','HIDS_UPDATE_TARGET'])
    if (!process.env[key]) throw new Error('缺少 '+key);
  const notes = JSON.parse(await readFile(notesFile, 'utf8'));
  const snapshot = await new PromptStore().snapshot();
  const payload = { type:'hids-prompts', api_version:1, target:process.env.HIDS_UPDATE_TARGET,
    version:notes.version, sequence:notes.sequence, date:notes.date, title:notes.title,
    summary:notes.summary, changes:notes.changes, ...snapshot };
  const encryptionKey = await readFile(process.env.HIDS_UPDATE_KEY_FILE);
  const privateKey = createPrivateKey(await readFile(process.env.HIDS_UPDATE_PRIVATE_KEY_FILE));
  if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('签名私钥必须为 Ed25519');
  const encoded = sealPackage(payload,{encryptionKey,privateKey});
  await writeFile(output, encoded, { mode:0o600, flag:'wx' });
  console.log('已生成加密签名策略包；请通过维护端上传，核对详情后应用。');
} else {
  console.log('生成密钥：node package-policy.js --init-keys <内部密钥目录>\n制作更新包：node package-policy.js <公开更新说明.json> <输出.hids-policy>\n密钥路径与环境标识通过 HIDS_UPDATE_* 环境变量提供。');
  process.exitCode=1;
}
