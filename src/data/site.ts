/** R2 公开访问前缀：开通公开域名或 r2.dev 后填这里 */
export const R2_BASE =
  import.meta.env.PUBLIC_R2_BASE?.replace(/\/$/, '') || '';

export const site = {
  name: '慧灯净土',
  domain: 'huidengjingtu.win',
  title: '慧灯净土',
  description: '慧灯净土修学平台。念佛修法、净土经典与净土修行。',
  footerNote: '本站内容仅供学修，禁止商业使用。文稿与音视频将陆续完善。',
  /** 工信部 ICP 备案号（无则留空） */
  icpNo: '',
};

export function assetUrl(path: string) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const clean = path.replace(/^\//, '');
  if (!R2_BASE) return '';
  return `${R2_BASE}/${clean}`;
}
