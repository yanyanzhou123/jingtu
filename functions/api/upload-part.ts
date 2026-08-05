import { type Env, isAllowedKey, json, requireAuth } from '../_lib/auth';

/**
 * 上传一个分片（单片仍须 < ~100MB；客户端按 8MB 切片即可）
 * PUT /api/upload-part?key=&uploadId=&partNumber=
 * Body: raw binary
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  const denied = await requireAuth(context.request, context.env);
  if (denied) return denied;
  if (!context.env.FILES) return json({ error: '未绑定 R2' }, 500);

  const url = new URL(context.request.url);
  const key = String(url.searchParams.get('key') || '').trim().replace(/^\/+/, '');
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber') || '0');

  if (!isAllowedKey(key) || !uploadId || !Number.isFinite(partNumber) || partNumber < 1) {
    return json({ error: '参数不完整' }, 400);
  }
  if (!context.request.body) {
    return json({ error: '缺少分片内容' }, 400);
  }

  try {
    const mpu = context.env.FILES.resumeMultipartUpload(key, uploadId);
    const part = await mpu.uploadPart(partNumber, context.request.body);
    return json({
      ok: true,
      partNumber: part.partNumber,
      etag: part.etag,
    });
  } catch (e) {
    return json({ error: `分片上传失败：${String(e)}` }, 500);
  }
};
