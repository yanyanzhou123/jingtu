import { type Env, json } from '../_lib/auth';
import { requireUser } from '../_lib/user-auth';

export type ProgressRow = {
  module_slug: string;
  lesson_slug: string;
  position_sec: number;
  completed: number;
  last_tab: string;
  updated_at: string;
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireUser(context.request, context.env);
  if (session instanceof Response) return session;

  const { results } = await context.env.DB!.prepare(
    `SELECT module_slug, lesson_slug, position_sec, completed, last_tab, updated_at
     FROM progress WHERE user_id = ? ORDER BY updated_at DESC`,
  )
    .bind(session.userId)
    .all<ProgressRow>();

  const items = (results || []).map((r) => ({
    moduleSlug: r.module_slug,
    lessonSlug: r.lesson_slug,
    positionSec: Number(r.position_sec) || 0,
    completed: !!r.completed,
    lastTab: r.last_tab || '',
    updatedAt: r.updated_at,
  }));

  return json({
    ok: true,
    items,
    recent: items[0] || null,
  });
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const session = await requireUser(context.request, context.env);
  if (session instanceof Response) return session;

  let body: {
    moduleSlug?: string;
    lessonSlug?: string;
    positionSec?: number;
    completed?: boolean;
    lastTab?: string;
  };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const moduleSlug = String(body.moduleSlug || '').trim();
  const lessonSlug = String(body.lessonSlug || '').trim();
  if (!moduleSlug || !lessonSlug) {
    return json({ error: '缺少 moduleSlug 或 lessonSlug' }, 400);
  }
  if (!/^[a-z0-9-]{1,64}$/i.test(moduleSlug) || !/^[a-z0-9-]{1,64}$/i.test(lessonSlug)) {
    return json({ error: '课程标识不合法' }, 400);
  }

  const positionSec = Math.max(0, Number(body.positionSec) || 0);
  const completed = body.completed ? 1 : 0;
  const lastTab = String(body.lastTab || '').slice(0, 32);
  const updatedAt = new Date().toISOString();

  await context.env.DB!.prepare(
    `INSERT INTO progress (user_id, module_slug, lesson_slug, position_sec, completed, last_tab, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, module_slug, lesson_slug) DO UPDATE SET
       position_sec = excluded.position_sec,
       completed = CASE
         WHEN excluded.completed = 1 OR progress.completed = 1 THEN 1
         ELSE 0
       END,
       last_tab = CASE
         WHEN excluded.last_tab != '' THEN excluded.last_tab
         ELSE progress.last_tab
       END,
       updated_at = excluded.updated_at`,
  )
    .bind(session.userId, moduleSlug, lessonSlug, positionSec, completed, lastTab, updatedAt)
    .run();

  return json({
    ok: true,
    item: {
      moduleSlug,
      lessonSlug,
      positionSec,
      completed: !!completed,
      lastTab,
      updatedAt,
    },
  });
};
