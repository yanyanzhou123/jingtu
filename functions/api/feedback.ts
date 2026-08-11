import { type Env, json, requireAuth } from '../_lib/auth';

const TYPES = ['practice', 'system'] as const;
type FeedbackType = (typeof TYPES)[number];

const STATUS = ['new', 'read', 'archived'] as const;
type FeedbackStatus = (typeof STATUS)[number];

const MAX_CONTENT = 1000;
const MAX_EMAIL = 120;
const RATE_PER_MIN = 3;

const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}\.[^\s@<>]{2,}$/;

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/** 按 IP 限流：每分钟最多 RATE_PER_MIN 条 */
async function allowRequest(request: Request): Promise<boolean> {
  try {
    const ip = clientIp(request);
    const bucket = Math.floor(Date.now() / 60000);
    const key = new Request(`https://jx-feedback-rate.internal/${ip}/${bucket}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= RATE_PER_MIN) return false;
    await cache.put(
      key,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': 'max-age=120' },
      }),
    );
    return true;
  } catch {
    return true;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isType(v: unknown): v is FeedbackType {
  return v === 'practice' || v === 'system';
}

function isStatus(v: unknown): v is FeedbackStatus {
  return v === 'new' || v === 'read' || v === 'archived';
}

function escapeSql(s: string): string {
  return String(s).replace(/'/g, "''");
}

/** 公开提交反馈 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return json({ error: '未绑定 D1' }, 500);
  }

  if (!(await allowRequest(request))) {
    return json({ error: '提交过于频繁，请稍后再试。' }, 429);
  }

  let body: { type?: string; content?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const type = String(body.type || '').trim();
  if (!isType(type)) {
    return json({ error: '请选择反馈类型' }, 400);
  }

  const content = String(body.content || '').trim();
  if (!content) {
    return json({ error: '请填写反馈内容' }, 400);
  }
  if (content.length > MAX_CONTENT) {
    return json({ error: `内容请控制在 ${MAX_CONTENT} 字以内` }, 400);
  }

  const email = String(body.email || '').trim();
  if (!email) {
    return json({ error: '请填写联系邮箱' }, 400);
  }
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return json({ error: '邮箱格式不正确' }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const status: FeedbackStatus = 'new';

  try {
    await env.DB.prepare(
      `INSERT INTO feedback (id, type, content, email, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, type, content, email, createdAt, status)
      .run();
  } catch (e) {
    return json({ error: `保存失败：${String(e)}` }, 500);
  }

  return json({ ok: true, id, createdAt });
};

/** 运营查看列表 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({ error: '未绑定 D1' }, 500);
  }

  const url = new URL(request.url);
  const status = String(url.searchParams.get('status') || '').trim();
  const type = String(url.searchParams.get('type') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  let where = '1=1';
  if (isStatus(status)) where += ` AND status = '${escapeSql(status)}'`;
  if (isType(type)) where += ` AND type = '${escapeSql(type)}'`;

  let rows: any[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, type, content, email, created_at, status
       FROM feedback
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    rows = res.results || [];
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  return json({ ok: true, count: rows.length, items: rows });
};

/** 运营标记状态 */
export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.DB) {
    return json({ error: '未绑定 D1' }, 500);
  }

  let body: { id?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const id = String(body.id || '').trim();
  if (!id) {
    return json({ error: '缺少 id' }, 400);
  }

  const status = String(body.status || '').trim();
  if (!isStatus(status)) {
    return json({ error: '状态只能为 new / read / archived' }, 400);
  }

  try {
    const res = await env.DB.prepare(
      `UPDATE feedback SET status = ? WHERE id = ?`,
    )
      .bind(status, id)
      .run();
    if (!res.meta || res.meta.changes === 0) {
      return json({ error: '未找到该反馈' }, 404);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  return json({ ok: true, id, status });
};
