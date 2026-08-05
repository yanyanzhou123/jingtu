import { type Env, isAllowedKey, json } from '../_lib/auth';

/** 公开下载：走 R2 并强制 attachment，触发浏览器「另存为」 */
function isDownloadableKey(key: string): boolean {
  if (!isAllowedKey(key)) return false;
  if (key.startsWith('config/')) return false;
  return true;
}

function filenameFromKey(key: string): string {
  const base = key.split('/').pop() || 'download';
  return base.replace(/[\r\n"]/g, '_');
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  if (!env.FILES) {
    return json({ error: '未绑定 R2（FILES）' }, 500);
  }

  const url = new URL(context.request.url);
  const key = (url.searchParams.get('path') || '').replace(/^\/+/, '');
  if (!isDownloadableKey(key)) {
    return json({ error: '不允许的路径' }, 400);
  }

  const obj = await env.FILES.get(key);
  if (!obj) {
    return json({ error: '文件不存在' }, 404);
  }

  const filename = filenameFromKey(key);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', contentDisposition(filename));
  headers.set('Cache-Control', 'private, no-store');
  if (obj.size != null) headers.set('Content-Length', String(obj.size));

  return new Response(obj.body, { headers });
};
