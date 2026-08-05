import { type Env, isAllowedKey, json, requireAuth } from '../_lib/auth';

const PUBLIC_BASE = 'https://pub-9e6c5d3469344f0da169b87d9b52b17d.r2.dev';

type Part = { partNumber: number; etag: string };

/** 完成分片上传 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  if (!context.env.FILES) return json({ error: '未绑定 R2' }, 500);

  let body: { key?: string; uploadId?: string; parts?: Part[] };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'JSON 无效' }, 400);
  }

  const key = String(body.key || '').trim().replace(/^\/+/, '');
  const uploadId = String(body.uploadId || '');
  const parts = body.parts || [];

  if (!isAllowedKey(key) || !uploadId || !parts.length) {
    return json({ error: '参数不完整' }, 400);
  }

  try {
    const mpu = context.env.FILES.resumeMultipartUpload(key, uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await mpu.complete(sorted);
    return json({
      ok: true,
      key,
      url: `${PUBLIC_BASE}/${key}`,
    });
  } catch (e) {
    try {
      const mpu = context.env.FILES.resumeMultipartUpload(key, uploadId);
      await mpu.abort();
    } catch {
      /* ignore */
    }
    return json({ error: `合并分片失败：${String(e)}` }, 500);
  }
};
