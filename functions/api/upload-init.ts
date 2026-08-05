import { type Env, isAllowedKey, json, requireAuth } from '../_lib/auth';
import { MEDIA_CACHE_CONTROL, contentTypeForKey } from '../_lib/media';

/** 初始化分片上传（大视频用） */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  if (!context.env.FILES) return json({ error: '未绑定 R2' }, 500);

  let body: { key?: string; contentType?: string };
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'JSON 无效' }, 400);
  }

  const key = String(body.key || '').trim().replace(/^\/+/, '');
  if (!isAllowedKey(key)) return json({ error: '路径不合法' }, 400);

  const contentType = contentTypeForKey(key, body.contentType || 'application/octet-stream');
  const mpu = await context.env.FILES.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
    },
  });

  return json({
    ok: true,
    key: mpu.key,
    uploadId: mpu.uploadId,
  });
};
