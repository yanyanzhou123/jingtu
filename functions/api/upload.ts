import { type Env, isAllowedKey, json, requireAuth } from '../_lib/auth';
import { MEDIA_CACHE_CONTROL, contentTypeForKey } from '../_lib/media';

/** 小文件整包上传（仍受 Worker 约 100MB 限制） */
const MAX_SIMPLE = 90 * 1024 * 1024;

const PUBLIC_BASE = 'https://pub-9e6c5d3469344f0da169b87d9b52b17d.r2.dev';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.FILES) {
    return json({ error: '未绑定 R2（FILES）' }, 500);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: '无法解析上传内容。大文件请使用分片上传。' }, 400);
  }

  const keyRaw = String(form.get('key') || '').trim().replace(/^\/+/, '');
  const file = form.get('file');

  if (!isAllowedKey(keyRaw)) {
    return json({ error: '路径不合法' }, 400);
  }
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: '请选择要上传的文件' }, 400);
  }
  if (file.size > MAX_SIMPLE) {
    return json({
      error: '文件较大，请使用分片上传（运营页已自动支持）。',
      code: 'USE_MULTIPART',
    }, 413);
  }

  const contentType = contentTypeForKey(keyRaw, file.type || 'application/octet-stream');
  await env.FILES.put(keyRaw, file.stream(), {
    httpMetadata: {
      contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
    },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
      originalName: file.name,
    },
  });

  return json({
    ok: true,
    key: keyRaw,
    size: file.size,
    contentType,
    url: `${PUBLIC_BASE}/${keyRaw}`,
  });
};
