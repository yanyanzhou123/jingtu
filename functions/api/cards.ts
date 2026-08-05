import { type Env, json, requireAuth } from '../_lib/auth';

/** 检索卡已停用：问答改用段落向量混合检索 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  return json({
    ok: false,
    disabled: true,
    error: '检索卡功能已停用，请使用「问答索引（向量）」。',
  }, 410);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  return json({
    ok: false,
    disabled: true,
    error: '检索卡功能已停用，请使用 /api/passages。',
  }, 410);
};
