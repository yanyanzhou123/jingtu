import { DEEPSEEK_MODEL, DEEPSEEK_URL } from './cards';

export async function deepseekChat(
  apiKey: string,
  system: string,
  user: string,
  opts: { temperature?: number; jsonMode?: boolean; maxTokens?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    temperature: opts.temperature ?? 0.3,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const aiData: any = await aiRes.json().catch(() => ({}));
  if (!aiRes.ok) {
    const msg = aiData?.error?.message || aiData?.message || `DeepSeek 错误 ${aiRes.status}`;
    throw new Error(msg);
  }
  const content = String(aiData?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('模型未返回内容');
  return content;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/** 简单 IP 限流（Cloudflare Cache） */
export async function allowRequest(
  request: Request,
  opts: { prefix: string; perMin?: number } = { prefix: 'jx-rate' },
): Promise<boolean> {
  const perMin = opts.perMin ?? 8;
  try {
    const ip = clientIp(request);
    const bucket = Math.floor(Date.now() / 60000);
    const key = new Request(`https://${opts.prefix}.internal/${ip}/${bucket}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= perMin) return false;
    await cache.put(
      key,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': 'max-age=120' },
      }),
    );
    return true;
  } catch {
    return true;
  }
}

export function stripMarkdownNoise(s: string): string {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}
