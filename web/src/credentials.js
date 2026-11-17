// 凭据只放内存。
// 不落 localStorage / sessionStorage：这个仓没有 token 机制，凭据就是 Basic 明文对，
// 落盘等于把密码留在浏览器里。代价是刷新页面要重新登录，这是有意的（见 web/README.md）。

let current = null;

/** @param {{ user: string, password: string }} credentials */
export function setCredentials(credentials) {
  current = { user: credentials.user, password: credentials.password };
}

/** @returns {{ user: string, password: string } | null} */
export function getCredentials() {
  return current;
}

export function hasCredentials() {
  return current !== null;
}

export function clearCredentials() {
  current = null;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 字节 → base64（RFC 7617 的 charset=UTF-8；不依赖 btoa/Buffer，测试与浏览器同一份实现） */
export function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : ALPHABET[c & 63];
  }
  return out;
}

/** 当前凭据的 Authorization 头；没有凭据返回 null */
export function authorizationHeader() {
  if (!current) return null;
  return `Basic ${base64(`${current.user}:${current.password}`)}`;
}
