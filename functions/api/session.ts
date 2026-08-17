import { type Env, json, requireAuth } from '../_lib/auth';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  const res = json({ ok: true });
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
