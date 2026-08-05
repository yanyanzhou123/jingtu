import { type Env, json } from '../../_lib/auth';
import {
  hashPassword,
  makeUserToken,
  normalizeUsername,
  requireDb,
  uid,
  userSessionCookie,
  validatePassword,
  validateUsername,
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

  const existing = await context.env.DB!.prepare(
    'SELECT id FROM users WHERE username = ? LIMIT 1',
  )
    .bind(username)
    .first();
  if (existing) return json({ error: '用户名已被注册' }, 409);

  const { hash, salt } = await hashPassword(password);
  const id = uid('u');
  const createdAt = new Date().toISOString();
  await context.env.DB!.prepare(
    'INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, username, hash, salt, createdAt)
    .run();

  const token = await makeUserToken(id, username, context.env);
  return json(
    { ok: true, user: { id, username } },
    200,
    { 'Set-Cookie': userSessionCookie(token) },
  );
};
