export interface Env {
  FILES: R2Bucket;
  OPS_PASSWORD: string;
  DEEPSEEK_API_KEY?: string;
  /** 定时 Worker 调用 /api/cards 时使用 */
  CRON_SECRET?: string;
  /** 学员账号与进度 */
  DB?: D1Database;
  /** 学员会话签名密钥；未设时回退 OPS_PASSWORD */
  APP_SESSION_SECRET?: string;
  /** Workers AI（bge-m3 等） */
  AI?: Ai;
  /** 段落向量索引 */
  VECTORIZE?: VectorizeIndex;
}

const COOKIE = 'jx_ops';
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

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

async function hmacKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function makeSessionToken(password: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp })));
  const key = await hmacKey(password);
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string, password: string): Promise<boolean> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const key = await hmacKey(password);
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
  );
  const got = b64urlToBytes(sig);
  if (expected.length !== got.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) ok |= expected[i] ^ got[i];
  if (ok !== 0) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { exp: number };
    return typeof data.exp === 'number' && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SEC}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(request: Request, name = COOKIE): string | null {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.OPS_PASSWORD) {
    return json({ error: '未配置 OPS_PASSWORD，请先在 Cloudflare 设置密钥。' }, 500);
  }
  const token = readCookie(request);
  if (!token || !(await verifySessionToken(token, env.OPS_PASSWORD))) {
    return json({ error: '未登录或登录已过期' }, 401);
  }
  return null;
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(headers || {}),
    },
  });
}

/** 只允许站点媒体与模块目录，防止乱传 */
export function isAllowedKey(key: string): boolean {
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('\\')) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(key)) return false;
  if (
    key.startsWith('books/') ||
    key.startsWith('audio/') ||
    key.startsWith('config/') ||
    key.startsWith('media/')
  ) {
    return true;
  }
  // 模块媒体：{slug}/...（slug 为小写字母开头的短标识，支持后台新增模块）
  return /^[a-z][a-z0-9-]{0,47}\//.test(key);
}
