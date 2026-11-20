export function checkExternalLink(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 HTTP 或 HTTPS 网址。');
  return url.href;
}
