import { type Env, json } from '../../_lib/auth';
import { clearUserSessionCookie } from '../../_lib/user-auth';

export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ ok: true }, 200, { 'Set-Cookie': clearUserSessionCookie() });
};
