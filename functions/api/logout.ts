import { type Env, clearSessionCookie, json } from '../_lib/auth';

export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
};
