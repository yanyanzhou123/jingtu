import { type Env, isAllowedKey, json, requireAuth } from '../_lib/auth';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.FILES) {
    return json({ error: '未绑定 R2（FILES）' }, 500);
  }

  const url = new URL(request.url);
  const prefix = (url.searchParams.get('prefix') || 'qianxing/').replace(/^\/+/, '');
  // 前缀本身或以 / 结尾的目录
  const probe = prefix.endsWith('/') ? `${prefix}x` : prefix;
  if (!isAllowedKey(probe) && !isAllowedKey(prefix)) {
    return json({ error: '不允许的前缀' }, 400);
  }

  const listed = await env.FILES.list({ prefix, limit: 200 });
  const objects = listed.objects.map((o) => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded?.toISOString?.() || null,
  }));

  return json({ objects, truncated: listed.truncated });
};
