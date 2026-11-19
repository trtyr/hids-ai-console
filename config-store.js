// 可写配置（P003-T029）：牧云与模型的六项能在运行中改，写盘后重启仍生效，响应与日志都不回显原文。
//
// 三层关系，别在别处再写一套：
//   1) 覆盖层文件（`<仓库>/.data/config-overrides.json`）只存「改过的键」，没改过的键继续读环境变量；
//   2) `createConfigStore()` 建的时候**同步**读覆盖层并盖进 env——「重启后仍生效」就是这一步，
//      所以它必须在 server.js 的模块级装配之前建：那批 `const gateway = … process.env …` 才看得到改过的值；
//   3) `update()` **先落盘再改内存与 env**：写盘失败就什么都不变（内存里改成功、盘上没改，重启就打回原形）。
//
// 取值校验复用装配处的构造器（rpc-client.js:4-5、model-client.js:22-24）：写进来的值必须能建成真客户端，
// 否则重启时装配就抛。判据只有一份，不在这里另写一套 URL / 长度正则。
// 校验对象是「合并后的生效值」：只改 LLM_MODEL 也要三项齐全——进程里这三项本来就由启动闸门保证齐全。
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { RpcClient } from './rpc-client.js';
import { ChatModelClient } from './model-client.js';

// 能写的只有这六项（A1 逐字点名：牧云地址/令牌、模型地址/密钥/模型名）。表外的键一律 400：
// HIDS_HOST/HIDS_PORT/HIDS_TRIAGE_INPUT_MODE 改起来必须重启进程；Basic 口令与两个 admin 令牌是鉴权凭据本身，写进来等于自己给自己开门。
export const WRITABLE_CONFIG_KEYS = Object.freeze(['CLOUDWALKER_URL', 'CLOUDWALKER_API_TOKEN',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']);

export function defaultConfigFile(directory = path.dirname(fileURLToPath(import.meta.url))) {
  return path.join(directory, '.data', 'config-overrides.json');
}

// 调用方传错一律带 status（与 readJSON 同一个口径，外层据此回 400 而不去猜文案）。
function callerError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// 建一次客户端只为让装配处的构造器判值：抛出来的原话只点键名，不带值（rpc-client.js:4-5、model-client.js:22-24）。
export function validateConfigValues(values) {
  if (values.CLOUDWALKER_URL || values.CLOUDWALKER_API_TOKEN)
    new RpcClient(values.CLOUDWALKER_URL, values.CLOUDWALKER_API_TOKEN);
  if (values.LLM_BASE_URL || values.LLM_API_KEY || values.LLM_MODEL)
    new ChatModelClient({ baseUrl: values.LLM_BASE_URL, apiKey: values.LLM_API_KEY, model: values.LLM_MODEL });
}

// 覆盖层文件只认可写键 + 非空字符串：手改坏的文件不能把进程带偏，也不能让表外的键混进 env。
function readOverrides(file, journal) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (cause) {
    if (cause.code === 'ENOENT') return {};
    journal('config.load_failed', { file, error: cause.message }, 'error');
    return {};
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (cause) { journal('config.load_failed', { file, error: cause.message }, 'error'); return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    journal('config.load_failed', { file, error: '覆盖层不是 JSON 对象' }, 'error');
    return {};
  }
  const kept = {};
  for (const key of WRITABLE_CONFIG_KEYS)
    if (typeof raw[key] === 'string' && raw[key].trim()) kept[key] = raw[key];
  return kept;
}

// 原子写：同目录 tmp + rename（跨设备不会发生在同一个目录里）。文件里是机密原文，权限收到 0600。
async function writeOverrides(file, overrides) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

// env / file / journal 都可注入：单测用字面量 env 与 tmp 目录，不碰真实 process.env 与仓内 .data/。
export function createConfigStore({ file = defaultConfigFile(), env = process.env, journal = log } = {}) {
  let overrides = readOverrides(file, journal);
  const apply = () => { for (const [key, value] of Object.entries(overrides)) env[key] = value; };
  apply();

  return {
    file,
    env,
    // 生效值（env 已被覆盖层盖过），给 server.js 的 applyLiveConfig 用。
    values: () => Object.fromEntries(WRITABLE_CONFIG_KEYS.map(key => [key, env[key] ?? null])),
    overrides: () => ({ ...overrides }),
    // 改了哪几个键就返回哪几个键（顺序＝正文里的顺序），响应与日志都用它。
    async update(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch))
        throw callerError('请求正文必须是 JSON 对象');
      const keys = Object.keys(patch);
      if (!keys.length) throw callerError('请求正文没有可写的配置项');
      const unknown = keys.filter(key => !WRITABLE_CONFIG_KEYS.includes(key));
      if (unknown.length) throw callerError(`配置项不可写：${unknown.join('、')}`);
      for (const key of keys)
        if (typeof patch[key] !== 'string' || !patch[key].trim())
          throw callerError(`配置项取值必须是非空字符串：${key}`);
      // 值不合法是调用方传错：构造器抛的原话原样回给调用方（只点键名，不带值），补 status 让外层分类成 400 而不是 500。
      try { validateConfigValues({ ...env, ...patch }); }
      catch (cause) { throw callerError(cause?.message || '配置值不合法'); }
      const next = { ...overrides, ...patch };
      await writeOverrides(file, next);
      overrides = next;
      apply();
      // 留痕只带键名（A5）：值与原文一个字都不进日志。
      journal('config.updated', { keys });
      return keys;
    }
  };
}
