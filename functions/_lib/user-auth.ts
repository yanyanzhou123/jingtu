import { type Env, json, readCookie } from './auth';

export const USER_COOKIE = 'jx_user';
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days
const SESSION_SECRET_FALLBACK = 'jx-app-session';

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sessionSecret(env: Env): string {
  return env.APP_SESSION_SECRET || env.OPS_PASSWORD || SESSION_SECRET_FALLBACK;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function uid(prefix = 'u'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function normalizeUsername(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function validateUsername(username: string): string | null {
  if (username.length < 3 || username.length > 32) return '用户名需 3～32 个字符';
  if (!/^[a-z0-9_\u4e00-\u9fff-]+$/i.test(username)) {
    return '用户名仅支持中文、字母、数字、下划线与连字符';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 6 || password.length > 72) return '密码需 6～72 个字符';
  return null;
}

export async function hashPassword(password: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltB64
    ? b64urlToBytes(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return {
    hash: b64url(bits),
    salt: b64url(salt),
  };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const next = await hashPassword(password, salt);
  if (next.hash.length !== hash.length) return false;
  let ok = 0;
  for (let i = 0; i < next.hash.length; i++) ok |= next.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return ok === 0;
}

export async function makeUserToken(userId: string, username: string, env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ uid: userId, u: username, exp })));
  const key = await hmacKey(sessionSecret(env));
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifyUserToken(
  token: string,
  env: Env,
): Promise<{ userId: string; username: string } | null> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const key = await hmacKey(sessionSecret(env));
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
  );
  const got = b64urlToBytes(sig);
  if (expected.length !== got.length) return null;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected[i] ^ got[i];
  if (ok !== 0) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as {
      uid?: string;
      u?: string;
      exp?: number;
    };
    if (!data.uid || !data.u || typeof data.exp !== 'number') return null;
    if (data.exp <= Math.floor(Date.now() / 1000)) return null;
    return { userId: data.uid, username: data.u };
  } catch {
    return null;
  }
}

export function userSessionCookie(token: string): string {
  return `${USER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`;
}

export function clearUserSessionCookie(): string {
  return `${USER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function requireUser(
  request: Request,
  env: Env,
): Promise<{ userId: string; username: string } | Response> {
  if (!env.DB) {
    return json({ error: '未绑定学员数据库（D1）' }, 500);
  }
  const token = readCookie(request, USER_COOKIE);
  if (!token) return json({ error: '请先登录' }, 401);
  const session = await verifyUserToken(token, env);
  if (!session) return json({ error: '登录已过期，请重新登录' }, 401);
  return session;
}

export function requireDb(env: Env): Response | null {
  if (!env.DB) return json({ error: '未绑定学员数据库（D1）' }, 500);
  return null;
}
