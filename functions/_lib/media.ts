/** Infer Content-Type from object key / filename for R2 uploads. */
export function contentTypeForKey(key: string, fallback = 'application/octet-stream'): string {
  const name = key.split('/').pop()?.toLowerCase() || '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.pdf':
      return 'application/pdf';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return fallback;
  }
}

/** Long cache for immutable lesson media (paths are stable). */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';
