import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { handleSceneAsset } from './scene_assets_CodexV3.mjs';

export const DESKTOP_ORIGIN = 'https://stilltime-app.invalid';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const STATIC_MIME_TYPES = {
  '.avif': 'image/avif', '.bin': 'application/octet-stream', '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.m4v': 'video/x-m4v', '.mjs': 'text/javascript; charset=utf-8', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream',
  '.otf': 'font/otf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.wav': 'audio/wav', '.wasm': 'application/wasm', '.webm': 'video/webm', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const STATIC_EXTENSIONS = new Set(Object.keys(STATIC_MIME_TYPES));
export const INSPIRATION_IMAGE_EXTENSIONS = [...IMAGE_EXTENSIONS, '.avif'];
const inspirationImageTypes = Object.fromEntries(INSPIRATION_IMAGE_EXTENSIONS.map(extension => [extension, STATIC_MIME_TYPES[extension]]));

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

async function sendFile(request, file, bounds, { cache = 'private, max-age=86400', ranges = false, mimeTypes = STATIC_MIME_TYPES, contentPolicy } = {}) {
  try {
    const [root, actual] = await Promise.all([realpath(bounds), realpath(file)]);
    const extension = path.extname(actual).toLowerCase();
    if (!within(root, actual) || extension !== path.extname(file).toLowerCase() || !mimeTypes[extension]) return null;
    const info = await stat(actual);
    if (!info.isFile()) return null;
    const headers = new Headers({
      'accept-ranges': ranges ? 'bytes' : 'none',
      'cache-control': cache,
      'content-length': String(info.size),
      'content-type': mimeTypes[extension],
      'x-content-type-options': 'nosniff',
    });
    if (contentPolicy) headers.set('content-security-policy', contentPolicy);
    let range = null;
    if (ranges && request.headers.get('range')) {
      range = parseRange(request.headers.get('range'), info.size);
      if (!range) {
        headers.set('content-range', `bytes */${info.size}`);
        headers.set('content-length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
      headers.set('content-length', String(range.end - range.start + 1));
    }
    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    const stream = createReadStream(actual, range ?? undefined);
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
  } catch {
    return null;
  }
}

function libraryItem(item) {
  const type = String(item.type ?? 'unknown').toLowerCase();
  const video = Boolean(item.playable && type === 'video');
  const image = Boolean(item.playable && type === 'image');
  const kind = video ? 'video' : image ? 'image' : 'preview';
  return {
    id: item.id,
    title: item.title,
    type,
    kind,
    live: ['scene', 'web'].includes(type) && Boolean(item.file && item.projectRoot && item.scanRoot),
    fileName: item.fileName ?? null,
    createdAtMs: item.createdAtMs ?? null,
    modifiedAtMs: item.modifiedAtMs ?? null,
    sizeBytes: item.sizeBytes ?? null,
    previewUrl: item.preview ? `/media/${encodeURIComponent(item.id)}/preview` : null,
    mediaUrl: video || image ? `/media/${encodeURIComponent(item.id)}/background` : null,
  };
}

export function createDesktopResources({ staticDirectory, getLibrary, getItem, steamRoot, getPdfPath, pdfDirectory, getInspirationImage }) {
  if (!staticDirectory || typeof getLibrary !== 'function' || typeof getItem !== 'function') {
    throw new TypeError('staticDirectory, getLibrary and getItem are required');
  }

  return async function handleDesktopRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { error: 'Invalid request' });
    }
    if (url.origin !== DESKTOP_ORIGIN) return json(403, { error: 'External network access is disabled' });
    if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });

    const imageMatch = /^\/api\/workbench\/inspiration-image\/([a-f0-9-]{36})$/i.exec(url.pathname);
    if (imageMatch && getInspirationImage && pdfDirectory) {
      const file = await getInspirationImage(imageMatch[1]).catch(() => null);
      const response = file && await sendFile(request, file, pdfDirectory, {
        cache: 'no-store', mimeTypes: inspirationImageTypes,
        contentPolicy: "default-src 'none'; sandbox; frame-ancestors 'none'",
      });
      return response || json(404, { error: '本地截图不可用' });
    }
    const pdfMatch = /^\/api\/workbench\/pdf\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
    if (pdfMatch && getPdfPath && pdfDirectory) {
      const file = await getPdfPath(pdfMatch[1]);
      const response = file && await sendFile(request, file, pdfDirectory, {
        cache: 'no-store',
        ranges: true,
        mimeTypes: { '.pdf': 'application/pdf' },
        contentPolicy: "default-src 'none'; sandbox; frame-ancestors 'none'",
      });
      return response || json(404, { error: '本地 PDF 不可用' });
    }

    if (url.pathname === '/api/library') {
      try {
        const library = await getLibrary();
        const items = library.items.map(libraryItem);
        const stats = {
          total: items.length,
          video: items.filter((item) => item.kind === 'video').length,
          image: items.filter((item) => item.kind === 'image').length,
          preview: items.filter((item) => item.kind === 'preview').length,
        };
        const response = json(200, { items, stats, source: '本机壁纸库', warnings: library.warnings ?? [] });
        return request.method === 'HEAD' ? new Response(null, { status: 200, headers: response.headers }) : response;
      } catch {
        return json(500, { error: '壁纸库读取失败，请检查本机壁纸目录。' });
      }
    }

    const mediaMatch = /^\/media\/([A-Za-z0-9_-]{1,160})\/(preview|background)$/.exec(url.pathname);
    if (mediaMatch) {
      try {
        const item = await getItem(mediaMatch[1]);
        const file = mediaMatch[2] === 'preview' ? item?.preview : item?.file;
        const extension = path.extname(file ?? '').toLowerCase();
        const mimeTypes = mediaMatch[2] === 'preview' ? Object.fromEntries(Object.entries(STATIC_MIME_TYPES).filter(([key]) => IMAGE_EXTENSIONS.has(key)))
          : Object.fromEntries(Object.entries(STATIC_MIME_TYPES).filter(([key]) => VIDEO_EXTENSIONS.has(key) || IMAGE_EXTENSIONS.has(key)));
        const validKind = mediaMatch[2] === 'preview' || ['video', 'image'].includes(String(item?.type).toLowerCase());
        if (!file || !validKind || !mimeTypes[extension] || !item.projectRoot || !item.scanRoot) {
          return json(404, { error: '此壁纸没有可用的媒体文件' });
        }
        const [scanRoot, projectRoot, actual] = await Promise.all([realpath(item.scanRoot), realpath(item.projectRoot), realpath(file)]);
        if (!within(scanRoot, projectRoot) || !within(projectRoot, actual)) return json(404, { error: '文件不可用' });
        const response = await sendFile(request, file, item.projectRoot, {
          ranges: mediaMatch[2] === 'background' && String(item.type).toLowerCase() === 'video',
          mimeTypes,
        });
        if (response) return response;
        return json(404, { error: '文件不可用' });
      } catch {
        return json(404, { error: '文件不可用' });
      }
    }

    const sceneResponse = await handleSceneAsset(request, url, { getItem, steamRoot });
    if (sceneResponse) return sceneResponse;

    let relative;
    try {
      relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      return json(400, { error: 'Invalid path' });
    }
    if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.'))) {
      return json(404, { error: 'File not found' });
    }
    const file = path.resolve(staticDirectory, relative.replace(/^\/+/, ''));
    if (!STATIC_EXTENSIONS.has(path.extname(file).toLowerCase())) return json(404, { error: 'File not found' });
    const contentPolicy = relative === '/index.html'
      ? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' https://stilltime-wallpaper.invalid https://stilltime-ouroboros.invalid; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      : undefined;
    const startupAudio = relative.startsWith('/startup/voice/') && /\.(mp3|ogg|wav)$/i.test(file);
    const response = await sendFile(request, file, staticDirectory, { cache: 'no-cache', contentPolicy, ranges: startupAudio });
    return response ?? json(404, { error: 'File not found' });
  };
}
