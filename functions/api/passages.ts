import { type Env, json, requireAuth } from '../_lib/auth';
import { extractLessonsFromCatalog, withHashes } from '../_lib/cards';
import {
  hybridReady,
  loadPassageStore,
  passageStatus,
  processPassageRebuild,
} from '../_lib/passages';

const CATALOG_KEY = 'config/catalog.json';

async function loadCatalog(env: Env, request: Request): Promise<any> {
  if (env.FILES) {
    const obj = await env.FILES.get(CATALOG_KEY);
    if (obj) return obj.json();
  }
  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/catalog.seed.json`);
  if (!res.ok) throw new Error('无法加载学修目录');
  return res.json();
}

async function requireOpsOrCron(request: Request, env: Env): Promise<Response | null> {
  const cron = request.headers.get('X-Cron-Secret') || '';
  if (cron) {
    if (env.CRON_SECRET && cron === env.CRON_SECRET) return null;
    if (env.OPS_PASSWORD && cron === env.OPS_PASSWORD) return null;
  }
  return requireAuth(request, env);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  try {
    const catalog = await loadCatalog(context.env, context.request);
    const lessons = await withHashes(extractLessonsFromCatalog(catalog));
    const store = await loadPassageStore(context.env);
    const status = passageStatus(context.env, store, lessons);
    return json({
      ok: true,
      hybridReady: hybridReady(context.env, store),
      updatedAt: store.updatedAt,
      ...status,
      pending: status.stale + status.missing,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!context.env.FILES) return json({ error: '未绑定 R2' }, 500);

  let body: any;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'JSON 无效' }, 400);
  }

  const action = String(body?.action || 'process').trim();

  try {
    const catalog = await loadCatalog(context.env, context.request);

    // 索引未建完时允许无登录预热（建完即关闭），避免卡在无 CRON_SECRET 的本地环境
    if (action === 'warm') {
      const lessons = await withHashes(extractLessonsFromCatalog(catalog));
      const store = await loadPassageStore(context.env);
      const status = passageStatus(context.env, store, lessons);
      const pending = status.stale + status.missing;
      if (pending <= 0) {
        return json({ ok: true, done: true, ...status });
      }
      const result = await processPassageRebuild(context.env, catalog, {
        limit: Math.min(12, Number(body?.limit) || 8),
      });
      return json({
        ok: true,
        done: result.left <= 0,
        pendingBefore: pending,
        ...result,
        ...passageStatus(context.env, await loadPassageStore(context.env), lessons),
      });
    }

    const denied = await requireOpsOrCron(context.request, context.env);
    if (denied) return denied;

    if (action === 'status') {
      const lessons = await withHashes(extractLessonsFromCatalog(catalog));
      const store = await loadPassageStore(context.env);
      return json({
        ok: true,
        hybridReady: hybridReady(context.env, store),
        ...passageStatus(context.env, store, lessons),
      });
    }

    if (action === 'process' || action === 'rebuild') {
      const result = await processPassageRebuild(context.env, catalog, {
        limit: Number(body?.limit) || 8,
        forceAll: action === 'rebuild' && !!body?.forceAll,
        lessonIds: Array.isArray(body?.lessonIds) ? body.lessonIds.map(String) : undefined,
      });
      return json({ ok: true, ...result });
    }

    return json({ error: `未知 action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
