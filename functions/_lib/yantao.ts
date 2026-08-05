import type { Env } from './auth';
import { sha256Short } from './cards';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export type ChatTurn = { role: 'user' | 'assistant' | 'system'; content: string };

export async function newSessionId(): Promise<string> {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  let hex = '';
  for (const b of rand) hex += b.toString(16).padStart(2, '0');
  const t = Date.now().toString(36);
  return `${t}_${hex}`;
}

export function sessionKey(kind: 'exam' | 'seminar', id: string): string {
  return `config/yantao-${kind}-sessions/${id}.json`;
}

export async function loadSession<T extends { expiresAt: number }>(
  env: Env,
  kind: 'exam' | 'seminar',
  id: string,
): Promise<T | null> {
  if (!env.FILES || !id) return null;
  const obj = await env.FILES.get(sessionKey(kind, id));
  if (!obj) return null;
  try {
    const data = (await obj.json()) as T;
    if (!data?.expiresAt || data.expiresAt < Date.now()) {
      await env.FILES.delete(sessionKey(kind, id)).catch(() => null);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function saveSession(
  env: Env,
  kind: 'exam' | 'seminar',
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!env.FILES) throw new Error('未绑定 R2');
  const payload = {
    ...data,
    expiresAt: Date.now() + SESSION_TTL_MS,
    updatedAt: new Date().toISOString(),
  };
  await env.FILES.put(sessionKey(kind, id), JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

/** 过长课文压缩到约 maxChars，保留首尾与中段 */
export function clipLessonText(text: string, maxChars = 12000): string {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  const head = Math.floor(maxChars * 0.4);
  const mid = Math.floor(maxChars * 0.2);
  const tail = maxChars - head - mid - 40;
  const midStart = Math.floor((t.length - mid) / 2);
  return (
    t.slice(0, head) +
    '\n\n……（中间节略）……\n\n' +
    t.slice(midStart, midStart + mid) +
    '\n\n……（后续节略）……\n\n' +
    t.slice(-tail)
  );
}

export async function contentFingerprint(text: string): Promise<string> {
  return sha256Short(text.slice(0, 8000));
}
