import { type Env, json, requireAuth } from '../_lib/auth';

const ARTICLES_KEY = 'config/article-collections.json';

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeArticleCollections(list: any): any[] {
  if (!Array.isArray(list)) return [];
  return list.map((col: any) => {
    const kind = col?.kind === 'link' ? 'link' : 'text';
    const articles = Array.isArray(col?.articles)
      ? col.articles.map((a: any) => ({
          id: a?.id || uid('art'),
          title: String(a?.title || '未命名文章').trim() || '未命名文章',
          url: String(a?.url || '').trim(),
          note: String(a?.note || '').trim(),
        }))
      : [];
    return {
      id: col?.id || uid('acol'),
      title: String(col?.title || '未命名集合').trim() || '未命名集合',
      kind,
      url: kind === 'link' ? String(col?.url || '').trim() : '',
      note: String(col?.note || '').trim(),
      articles: kind === 'text' ? articles : [],
    };
  });
}

async function readArticles(env: Env): Promise<{ rev: number; collections: any[] }> {
  if (!env.FILES) return { rev: 0, collections: [] };
  const obj = await env.FILES.get(ARTICLES_KEY);
  if (!obj) return { rev: 0, collections: [] };
  try {
    const raw = (await obj.json()) as any;
    return {
      rev: Number(raw?.rev) || 0,
      collections: normalizeArticleCollections(raw?.collections ?? raw?.articleCollections),
    };
  } catch {
    return { rev: 0, collections: [] };
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const data = await readArticles(context.env);
    const res = json(data);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  if (!context.env.FILES) return json({ error: '未绑定 R2' }, 500);

  let body: any;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'JSON 无效' }, 400);
  }

  const current = await readArticles(context.env);
  const baseRevRaw = body?.baseRev;
  const baseRev =
    baseRevRaw === undefined || baseRevRaw === null || baseRevRaw === ''
      ? null
      : Number(baseRevRaw);

  if (baseRev !== null && !Number.isNaN(baseRev) && baseRev !== current.rev) {
    return json(
      {
        error: '公众号好文已被他人更新，请重新加载后再保存。',
        code: 'CONFLICT',
        serverRev: current.rev,
        clientRev: baseRev,
      },
      409,
    );
  }

  const collections = normalizeArticleCollections(body?.collections ?? body?.articleCollections);
  const rev = current.rev + 1;
  const payload = {
    version: 1,
    rev,
    collections,
    updatedAt: new Date().toISOString(),
  };

  await context.env.FILES.put(ARTICLES_KEY, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  return json({ ok: true, rev, count: collections.length });
};
