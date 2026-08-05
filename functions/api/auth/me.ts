import { type Env, json } from '../../_lib/auth';
import { requireUser } from '../../_lib/user-auth';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireUser(context.request, context.env);
  if (session instanceof Response) return session;
  return json({
    ok: true,
    user: { id: session.userId, username: session.username },
  });
};
