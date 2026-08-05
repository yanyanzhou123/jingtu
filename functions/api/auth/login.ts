import { type Env, json } from '../../_lib/auth';
import {
  makeUserToken,
  normalizeUsername,
  requireDb,
  userSessionCookie,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../../_lib/user-auth';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const denied = requireDb(context.env);
  if (denied) return denied;

  let body: { username?: string; password?: string };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const username = normalizeUsername(body.username || '');
  const password = String(body.password || '');
  const uErr = validateUsername(username);
  if (uErr) return json({ error: uErr }, 400);
  const pErr = validatePassword(password);
  if (pErr) return json({ error: pErr }, 400);

  const row = await context.env.DB!.prepare(
    'SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ? LIMIT 1',
  )
    .bind(username)
    .first<{ id: string; username: string; pass_hash: string; pass_salt: string }>();

  if (!row || !(await verifyPassword(password, row.pass_hash, row.pass_salt))) {
    return json({ error: '用户名或密码不正确' }, 401);
  }

  const token = await makeUserToken(row.id, row.username, context.env);
  return json(
    { ok: true, user: { id: row.id, username: row.username } },
    200,
    { 'Set-Cookie': userSessionCookie(token) },
  );
};
