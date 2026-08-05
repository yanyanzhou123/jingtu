import {
  type Env,
  json,
  makeSessionToken,
  sessionCookie,
} from '../_lib/auth';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!env.OPS_PASSWORD) {
    return json({ error: '未配置 OPS_PASSWORD' }, 500);
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  if (!body.password || body.password !== env.OPS_PASSWORD) {
    return json({ error: '密码错误' }, 401);
  }

  const token = await makeSessionToken(env.OPS_PASSWORD);
  return json(
    { ok: true },
    200,
    {
      'Set-Cookie': sessionCookie(token),
    },
  );
};
