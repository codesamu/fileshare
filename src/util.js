import crypto from 'node:crypto';
import path from 'node:path';

const MIME = {
  // images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff',
  tiff: 'image/tiff', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  // video
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg', mpg: 'video/mpeg',
  mpeg: 'video/mpeg', ts: 'video/mp2t', wmv: 'video/x-ms-wmv',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  // docs
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', log: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  sh: 'text/plain', py: 'text/plain', go: 'text/plain', rs: 'text/plain',
  java: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain',
  sql: 'text/plain', ini: 'text/plain', conf: 'text/plain', env: 'text/plain',
  srt: 'text/plain', vtt: 'text/vtt', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // archives / binaries
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2',
  xz: 'application/x-xz', iso: 'application/x-iso9660-image', dmg: 'application/x-apple-diskimage',
  exe: 'application/x-msdownload', apk: 'application/vnd.android.package-archive',
};

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'toml',
  'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'sh', 'py', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'sql', 'ini', 'conf', 'env', 'srt', 'vtt',
]);

export function extOf(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function mimeFor(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

/** Coarse file category used by the UI to decide how to preview a file. */
export function kindFor(name, mime = mimeFor(name)) {
  const ext = extOf(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return 'text';
  return 'other';
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function contentDisposition(name, type = 'attachment') {
  const cleaned = String(name).replace(/[\r\n]/g, ' ').slice(0, 200);
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Resolve `rel` under `root`, refusing anything that escapes it. */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
