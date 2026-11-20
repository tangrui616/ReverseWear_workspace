import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const MAX_PKG_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const INVALID_PATH_CHARACTER = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}<>:"\\|?*]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i;
const ASSET_EXTENSIONS = new Set(['.json', '.tex', '.mdl', '.vert', '.frag', '.glsl', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.vsh', '.fsh']);
const ENGINE_DIRECTORIES = new Set(['materials', 'effects', 'particles', 'shaders', 'fonts', 'models', 'presets']);
const MIME = { '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const packageIndexes = new Map();

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function engineAssetsRoot(steamRoot) {
  return path.basename(steamRoot).toLowerCase() === 'wallpaper_engine'
    ? path.join(steamRoot, 'assets')
    : path.join(steamRoot, 'steamapps', 'common', 'wallpaper_engine', 'assets');
}

function safeName(name) {
  // Keep Unicode filename characters intact so they match the package index or disk entry exactly.
  // Trailing dots and spaces can be dropped by Windows, including in traversal segments.
  return typeof name === 'string' && name.length > 0 && name.length <= 512
    && !INVALID_PATH_CHARACTER.test(name)
    && !name.split('/').some(part => !part || /[. ]$/.test(part) || WINDOWS_DEVICE_NAME.test(part));
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

function readRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start; let end;
  if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  else { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) return false; start = Math.max(0, size - suffix); end = size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(size - 1, end) };
}

async function serveFile(request, file, boundsRoot) {
  try {
    const [root, actual] = await Promise.all([realpath(boundsRoot), realpath(file)]);
    const ext = path.extname(actual).toLowerCase();
    if (!within(root, actual) || !ASSET_EXTENSIONS.has(ext) || ext !== path.extname(file).toLowerCase()) return null;
    const info = await stat(actual);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
    const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'content-length': info.size, 'content-type': MIME[path.extname(actual).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    let range = null;
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      range = readRange(rangeHeader, info.size);
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
  } catch { return null; }
}

async function pkgIndex(file, projectRoot) {
  const actual = await realpath(file);
  if (!within(projectRoot, actual)) return null;
  const info = await stat(actual);
  if (!info.isFile() || info.size < 16 || info.size > 4 * 1024 * 1024 * 1024) return null;
  const key = `${actual}\0${info.size}\0${info.mtimeMs}`;
  if (packageIndexes.has(key)) return packageIndexes.get(key);
  const handle = await open(actual, 'r');
  try {
    const prefix = Buffer.alloc(16);
    const { bytesRead } = await handle.read(prefix, 0, 16, 0);
    if (bytesRead !== 16 || prefix.readUInt32LE(0) !== 8 || prefix.toString('ascii', 4, 8) !== 'PKGV') return null;
    const count = prefix.readUInt32LE(12);
    if (count > 100_000) return null;
    // Entry names can be multilingual, so use UTF-8 lengths but check every offset against the file.
    const names = [];
    let cursor = 16;
    for (let i = 0; i < count; i++) {
      const lenBuf = Buffer.alloc(4);
      if (cursor + 4 > info.size || (await handle.read(lenBuf, 0, 4, cursor)).bytesRead !== 4) return null;
      const nameLength = lenBuf.readUInt32LE(0); cursor += 4;
      if (nameLength < 1 || nameLength > 4096 || cursor + nameLength + 8 > info.size) return null;
      const nameBuf = Buffer.alloc(nameLength);
      if ((await handle.read(nameBuf, 0, nameLength, cursor)).bytesRead !== nameLength) return null;
      const name = nameBuf.toString('utf8'); cursor += nameLength;
      const meta = Buffer.alloc(8);
      if ((await handle.read(meta, 0, 8, cursor)).bytesRead !== 8) return null;
      cursor += 8;
      const offset = meta.readUInt32LE(0); const length = meta.readUInt32LE(4);
      names.push({ name, relative: offset, length });
      if (cursor > MAX_PKG_INDEX_BYTES) return null;
    }
    const dataStart = cursor;
    const entries = new Map();
    for (const item of names) {
      const start = dataStart + item.relative;
      const end = start + item.length;
      if (!safeName(item.name) || !Number.isSafeInteger(start) || end > info.size || end < start || item.length > MAX_ASSET_BYTES) continue;
      entries.set(item.name, { start, end, length: item.length });
    }
    const result = { file: actual, entries };
    packageIndexes.clear();
    packageIndexes.set(key, result);
    return result;
  } finally { await handle.close(); }
}

async function servePkgEntry(request, pkg, name) {
  const entry = pkg.entries.get(name);
  if (!entry) return null;
  const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'content-length': entry.length, 'content-type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  let range = null;
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    range = readRange(rangeHeader, entry.length);
    if (!range) {
      headers.set('content-range', `bytes */${entry.length}`);
      headers.set('content-length', '0');
      return new Response(null, { status: 416, headers });
    }
    headers.set('content-range', `bytes ${range.start}-${range.end}/${entry.length}`);
    headers.set('content-length', String(range.end - range.start + 1));
  }
  if (request.method === 'HEAD' || entry.length === 0) return new Response(null, { status: range ? 206 : 200, headers });
  const base = entry.start + (range?.start ?? 0); const end = entry.start + (range?.end ?? entry.length - 1);
  const stream = createReadStream(pkg.file, { start: base, end });
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}

async function projectEntry(item, name) {
  if (!safeName(name) || !ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) return null;
  const file = item.file;
  if (!file || !item.projectRoot || !item.scanRoot) return null;
  try {
    const projectRoot = await realpath(item.projectRoot);
    const scanRoot = await realpath(item.scanRoot);
    if (!within(scanRoot, projectRoot)) return null;
    if (path.extname(file).toLowerCase() === '.pkg') {
      const pkg = await pkgIndex(file, projectRoot);
      const found = pkg?.entries.get(name);
      if (found) return { pkg };
    }
    const candidate = name === 'scene.json' && path.extname(file).toLowerCase() === '.json' ? file : path.resolve(projectRoot, name);
    if (!within(projectRoot, candidate)) return null;
    const actual = await realpath(candidate);
    if (!within(projectRoot, actual) || !within(scanRoot, actual) || !(await stat(actual)).isFile()) return null;
    return { file: actual, root: projectRoot };
  } catch { return null; }
}

async function serveSceneEntry(request, item, name, steamRoot) {
  const found = await projectEntry(item, name);
  if (found?.pkg) return servePkgEntry(request, found.pkg, name);
  if (found?.file) return serveFile(request, found.file, found.root);

  // Wallpaper Engine mounts built-in textures beneath assets/materials. They are read-only inputs.
  if (ENGINE_DIRECTORIES.has(name.split('/')[0])) {
    const assetsRoot = engineAssetsRoot(steamRoot);
    return serveFile(request, path.join(assetsRoot, name), assetsRoot);
  }
  return null;
}

async function projectDefaults(item) {
  const result = { properties: [], audioProcessing: false };
  try {
    if (!item.projectRoot || !item.scanRoot) return result;
    const [root, scan] = await Promise.all([realpath(item.projectRoot), realpath(item.scanRoot)]);
    const file = await realpath(path.join(root, 'project.json'));
    const info = await stat(file);
    if (!within(scan, root) || !within(root, file) || path.extname(file).toLowerCase() !== '.json' || !info.isFile() || info.size > 2 * 1024 * 1024) return result;
    const handle = await open(file, 'r');
    try {
      const document = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
      for (const [key, def] of Object.entries(document?.general?.properties ?? {}).slice(0, 512)) {
        if (!/^[A-Za-z0-9_-]{1,96}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !def || !['boolean', 'number', 'string'].includes(typeof def.value)) continue;
        if (typeof def.value === 'string' && def.value.length > 1024) continue;
        result.properties.push({ key, value: def.value, ...(typeof def.condition === 'string' && def.condition.length <= 256 ? { condition: def.condition } : {}) });
      }
    } finally { await handle.close(); }
  } catch { /* Defaults are optional for a scene. */ }
  return result;
}

export async function handleSceneAsset(request, url, { getItem, steamRoot }) {
  const route = url.pathname;
  const match = /^\/wallpapers\/scene\/([A-Za-z0-9_-]{32})\/asset$/.exec(route);
  if (match) {
    if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    const name = url.searchParams.get('name') ?? '';
    if (!safeName(name) || !ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) return json(400, { error: 'bad name' });
    const item = await getItem(match[1]);
    if (!item || item.type !== 'scene') return json(404, { error: 'no such scene' });
    return await serveSceneEntry(request, item, name, steamRoot) ?? json(404, { error: 'no such asset' });
  }

  if (route === '/wallpapers/particle-texture') {
    if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    const name = url.searchParams.get('name') ?? '';
    const id = url.searchParams.get('id') ?? '';
    if (!safeName(name) || name.toLowerCase().endsWith('.tex')) return json(400, { error: 'bad name' });
    if (id) {
      const item = await getItem(id);
      if (item?.type === 'scene') {
        const found = await projectEntry(item, `materials/${name}.tex`);
        if (found?.pkg) {
          const asset = await servePkgEntry(request, found.pkg, `materials/${name}.tex`);
          if (asset) return asset;
        }
        if (found?.file) {
          const asset = await serveFile(request, found.file, found.root);
          if (asset) return asset;
        }
      }
    }
    const assetsRoot = engineAssetsRoot(steamRoot);
    return await serveFile(request, path.join(assetsRoot, 'materials', `${name}.tex`), assetsRoot) ?? json(404, { error: 'no such texture' });
  }

  if (route === '/wallpapers/properties') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    const item = await getItem(url.searchParams.get('id') ?? '');
    if (!item || item.type !== 'scene') return json(400, { error: 'bad id' });
    return request.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
      : json(200, await projectDefaults(item));
  }
  return null;
}
