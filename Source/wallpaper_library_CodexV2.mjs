import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const execFile = promisify(execFileCallback);
const APP_ID = '431960';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PREVIEW_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.gif']);

function unescapeVdf(value) {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

export function parseLibraryFoldersVdf(text) {
  const libraries = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*"(?:path|\d+)"\s*"((?:\\.|[^"\\])*)"/i);
    if (!match) continue;
    const value = unescapeVdf(match[1]);
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) libraries.add(path.isAbsolute(value) ? path.resolve(value) : path.win32.normalize(value));
  }
  return [...libraries];
}

async function registrySteamRoots(platform) {
  if (platform !== 'win32') return [];
  const roots = [];
  for (const hive of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\Software\\WOW6432Node\\Valve\\Steam']) {
    try {
      const { stdout } = await execFile('reg.exe', ['query', hive, '/v', 'SteamPath'], {
        windowsHide: true,
        timeout: 1500,
        maxBuffer: 32 * 1024,
      });
      const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)\s*$/im);
      if (match) roots.push(match[1].trim());
    } catch {
      // Steam is optional. A missing registry value should not block discovery.
    }
  }
  return roots;
}

export async function discoverSteamRoots({ explicitRoot, discoverAdditionalRoots = false, env = process.env, platform = process.platform } = {}) {
  const configuredRoot = [explicitRoot, env.CODEX_WALLPAPER_STEAM_ROOT, env.STEAM_ROOT]
    .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)?.trim();
  const candidates = [
      ...(configuredRoot ? [configuredRoot] : []),
      ...(!configuredRoot || discoverAdditionalRoots ? [
      ...(await registrySteamRoots(platform)),
      ...(platform === 'win32'
        ? [path.join(env.PROGRAMFILES || 'C:/Program Files', 'Steam'), path.join(env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Steam')]
        : platform === 'darwin'
          ? [path.join(env.HOME ?? '', 'Library/Application Support/Steam')]
          : [path.join(env.HOME ?? '', '.steam/steam'), path.join(env.HOME ?? '', '.local/share/Steam')]),
      ] : []),
    ];
  const roots = new Set();
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(path.resolve(candidate));
      const stat = await fs.stat(resolved);
      if (stat.isDirectory() && await isDirectory(path.join(resolved, 'steamapps'))) roots.add(resolved);
    } catch {
      // Ignore stale configuration and unreachable disks.
    }
  }
  return [...roots];
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverLibraryDirectories(steamRoots) {
  const libraries = new Set();
  for (const steamRoot of steamRoots) {
    libraries.add(steamRoot);
    const foldersFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    try {
      const text = await fs.readFile(foldersFile, 'utf8');
      for (const library of parseLibraryFoldersVdf(text)) {
        if (await isDirectory(path.join(library, 'steamapps'))) libraries.add(await fs.realpath(library));
      }
    } catch {
      // A Steam installation without libraryfolders.vdf still has its default library.
    }
  }
  return [...libraries];
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function confinedFile(projectRoot, relativePath, extensions) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) return null;
  const lexical = path.resolve(projectRoot, relativePath);
  if (!isWithin(projectRoot, lexical)) return null;
  if (!extensions.has(path.extname(lexical).toLowerCase())) return null;
  try {
    const actual = await fs.realpath(lexical);
    if (!isWithin(projectRoot, actual) || !(await fs.stat(actual)).isFile()) return null;
    return actual;
  } catch {
    return null;
  }
}

async function inspectProjectFile(projectRoot, relativePath, extensions) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) return { status: 'missing', file: null };
  const lexical = path.resolve(projectRoot, relativePath);
  if (!isWithin(projectRoot, lexical) || lexical === projectRoot) return { status: 'unsafe', file: null };
  const allowedExtension = extensions.has(path.extname(lexical).toLowerCase());
  let cursor = lexical;
  while (isWithin(projectRoot, cursor)) {
    try {
      const actual = await fs.realpath(cursor);
      if (!isWithin(projectRoot, actual)) return { status: 'unsafe', file: null };
      if (cursor === lexical) {
        const stat = await fs.stat(actual);
        if (!stat.isFile()) return { status: 'unsafe', file: null };
        if (!allowedExtension) return { status: 'invalid', file: null };
        return { status: 'safe', file: actual };
      }
      if (cursor === projectRoot) return { status: allowedExtension ? 'missing' : 'invalid', file: null };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return { status: 'unsafe', file: null };
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink()) return { status: 'unsafe', file: null };
      } catch { /* a missing path component is handled by the parent walk */ }
      if (cursor === projectRoot) return { status: allowedExtension ? 'missing' : 'invalid', file: null };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return { status: 'unsafe', file: null };
    cursor = parent;
  }
  return { status: 'unsafe', file: null };
}

async function projectRecord(projectDirectory, trustedScanRoot, allowRoot = false) {
  let directory;
  try {
    directory = await fs.realpath(projectDirectory);
    if (!isWithin(trustedScanRoot, directory) || (directory === trustedScanRoot && !allowRoot)) return null;
  } catch {
    return null;
  }

  const metadataPath = await confinedFile(directory, 'project.json', new Set(['.json']));
  if (!metadataPath) return null;
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const hasDeclaredFile = typeof metadata.file === 'string' && metadata.file.trim().length > 0;
  const declared = hasDeclaredFile ? metadata.file : '';
  let type = typeof metadata.type === 'string' ? metadata.type.toLowerCase() : '';
  if (!['scene', 'video', 'web', 'application', 'image'].includes(type)) {
    const extension = path.extname(declared).toLowerCase();
    type = VIDEO_EXTENSIONS.has(extension) ? 'video'
      : IMAGE_EXTENSIONS.has(extension) ? 'image'
        : /\.html?$/i.test(extension) ? 'web' : 'scene';
  }
  const projectExtensions = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, '.html', '.htm', '.js', '.json', '.pkg', '.zip', '.exe']);
  let file = null;
  if (hasDeclaredFile) {
    const declaredResult = await inspectProjectFile(directory, declared, projectExtensions);
    if (declaredResult.status === 'unsafe' || declaredResult.status === 'invalid') return null;
    if (declaredResult.status === 'safe') file = declaredResult.file;
    if (!file && declaredResult.status === 'missing' && type === 'scene') {
      for (const candidate of ['scene.pkg', 'scene.json']) {
        const result = await inspectProjectFile(directory, candidate, projectExtensions);
        if (result.status === 'unsafe' || result.status === 'invalid') return null;
        if (result.status === 'safe') { file = result.file; break; }
      }
      if (!file) {
        let names = [];
        try { names = await fs.readdir(directory); } catch { return null; }
        const packages = names.filter((name) => name.toLowerCase().endsWith('.pkg'));
        if (packages.length === 1) {
          const result = await inspectProjectFile(directory, packages[0], projectExtensions);
          if (result.status === 'unsafe' || result.status === 'invalid') return null;
          if (result.status === 'safe') file = result.file;
        }
      }
    }
  }
  const fileExtension = file ? path.extname(file).toLowerCase() : '';
  const fileExtensionMatchesType = (type === 'video' && VIDEO_EXTENSIONS.has(fileExtension))
    || (type === 'image' && IMAGE_EXTENSIONS.has(fileExtension));
  const playable = file !== null && fileExtensionMatchesType;
  const preview = await confinedFile(directory, metadata.preview, PREVIEW_EXTENSIONS);
  const timestampFile = file ?? (type === 'scene' || type === 'web' ? preview : null);
  let fileName = null;
  let createdAtMs = null;
  let modifiedAtMs = null;
  let sizeBytes = null;
  if (timestampFile) {
    try {
      const fileStat = await fs.stat(timestampFile);
      if (fileStat.isFile()) {
        fileName = path.basename(timestampFile);
        createdAtMs = Number.isFinite(fileStat.birthtimeMs) && fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : null;
        modifiedAtMs = Number.isFinite(fileStat.mtimeMs) ? fileStat.mtimeMs : null;
        sizeBytes = Number.isSafeInteger(fileStat.size) ? fileStat.size : null;
      }
    } catch { /* File metadata is optional for the library listing. */ }
  }
  const reason = !file ? 'missing-main-file'
    : type === 'scene' ? 'scene-renderer-unavailable'
      : type === 'web' ? 'web-renderer-unavailable'
        : type === 'application' ? 'application-not-executable'
          : playable ? null : 'media-type-mismatch';
  const key = `${directory}\0${file ?? ''}\0${declared}`;
  const id = createHash('sha256').update(key).digest('base64url').slice(0, 32);
  return Object.freeze({
    id,
    title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim().slice(0, 160) : path.basename(directory),
    type,
    playable,
    reason,
    hasPreview: Boolean(preview),
    fileName,
    createdAtMs,
    modifiedAtMs,
    sizeBytes,
    projectRoot: directory,
    scanRoot: trustedScanRoot,
    file,
    preview,
    fileExtensionMatchesType,
    mimeType: file ? type === 'video' ? videoMime(file) : imageMime(file) : 'application/octet-stream',
  });
}

function mediaRecord(file, trustedScanRoot, info) {
  const extension = path.extname(file).toLowerCase();
  const type = VIDEO_EXTENSIONS.has(extension) ? 'video' : 'image';
  const id = createHash('sha256').update(file).digest('base64url').slice(0, 32);
  return Object.freeze({
    id,
    title: path.basename(file, extension).slice(0, 160) || path.basename(file).slice(0, 160),
    type,
    playable: true,
    reason: null,
    hasPreview: type === 'image',
    fileName: path.basename(file),
    createdAtMs: Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : null,
    modifiedAtMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
    sizeBytes: Number.isSafeInteger(info.size) ? info.size : null,
    projectRoot: trustedScanRoot,
    scanRoot: trustedScanRoot,
    file,
    preview: type === 'image' ? file : null,
    fileExtensionMatchesType: true,
    mimeType: type === 'video' ? videoMime(file) : imageMime(file),
  });
}

async function scanSelectedFolder(root) {
  const records = [];
  const pending = [root];
  const seenDirectories = new Set();
  while (pending.length > 0) {
    const batch = pending.splice(0, 8);
    const results = await Promise.all(batch.map(async (directory) => {
      let actualDirectory;
      try {
        actualDirectory = await fs.realpath(directory);
        if (!isWithin(root, actualDirectory) || seenDirectories.has(actualDirectory)) return null;
        seenDirectories.add(actualDirectory);
        const metadata = await confinedFile(actualDirectory, 'project.json', new Set(['.json']));
        if (metadata) {
          const project = await projectRecord(actualDirectory, root, true);
          return project ? { project } : null;
        }
        return { actualDirectory, entries: await fs.readdir(actualDirectory, { withFileTypes: true }) };
      } catch {
        return null;
      }
    }));
    for (const result of results) {
      if (!result) continue;
      if (result.project) {
        records.push(result.project);
        continue;
      }
      for (const entry of result.entries) {
        if (entry.name.startsWith('.')) continue;
        const lexical = path.join(result.actualDirectory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          pending.push(lexical);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) continue;
        try {
          const actual = await fs.realpath(lexical);
          if (!isWithin(root, actual)) continue;
          const info = await fs.stat(actual);
          if (info.isFile()) records.push(mediaRecord(actual, root, info));
        } catch { /* An inaccessible media file does not block the folder scan. */ }
      }
    }
  }
  return records;
}

export function videoMime(file) {
  return ({ '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function imageMime(file) {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export class WallpaperLibrary {
  constructor({ steamRoot, discoverAdditionalRoots = false, folderRoots = [], env = process.env, platform = process.platform, refreshMs = 3000, logger = () => {} } = {}) {
    this.options = { steamRoot, discoverAdditionalRoots, folderRoots: [...new Set(folderRoots)], env, platform };
    this.refreshMs = refreshMs;
    this.logger = logger;
    this.cache = null;
    this.cachedAt = 0;
    this.pending = null;
  }

  async #scan() {
    const roots = await discoverSteamRoots({ ...this.options, explicitRoot: this.options.steamRoot });
    const libraries = await discoverLibraryDirectories(roots);
    const candidates = new Map();
    const unavailableFolderRoots = [];
    const selectedRoots = new Set();
    for (const configuredRoot of this.options.folderRoots) {
      if (typeof configuredRoot !== 'string' || configuredRoot.trim().length === 0) continue;
      try {
        const actual = await fs.realpath(path.resolve(configuredRoot));
        await fs.readdir(actual);
        selectedRoots.add(actual);
      } catch { unavailableFolderRoots.push(configuredRoot); }
    }
    for (const library of libraries) {
      const installation = path.join(library, 'steamapps', 'common', 'wallpaper_engine');
      for (const name of ['defaultprojects', 'myprojects']) {
        const root = path.join(installation, 'projects', name);
        try {
          const real = await fs.realpath(root);
          if (await isDirectory(real)) candidates.set(real, real);
        } catch { /* optional project directory */ }
      }

      const workshop = path.join(library, 'steamapps', 'workshop', 'content', APP_ID);
      try {
        const real = await fs.realpath(workshop);
        if (await isDirectory(real)) candidates.set(real, real);
      } catch { /* optional workshop content */ }
    }

    const records = [];
    const queue = [];
    for (const trustedRoot of candidates.values()) {
      let children;
      try { children = await fs.readdir(trustedRoot, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith('.')) continue;
        queue.push(projectRecord(path.join(trustedRoot, child.name), trustedRoot));
        if (queue.length >= 32) {
          for (const result of await Promise.all(queue.splice(0))) if (result) records.push(result);
        }
      }
    }
    for (const result of await Promise.all(queue)) if (result) records.push(result);
    const selectedItems = await Promise.all([...selectedRoots].map((root) => scanSelectedFolder(root)));
    for (const item of selectedItems.flat()) records.push(item);
    const uniqueRecords = [...new Map(records.map((item) => [item.id, item])).values()];
    uniqueRecords.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    this.logger(`Wallpaper scan: ${uniqueRecords.length} records across ${candidates.size + selectedRoots.size} roots.`);
    return { steamRoots: roots, scanRoots: [...new Set([...candidates.values(), ...selectedRoots])], unavailableFolderRoots, items: uniqueRecords };
  }

  async snapshot({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cachedAt < this.refreshMs) return this.cache;
    if (this.pending) return this.pending;
    this.pending = this.#scan();
    try {
      this.cache = await this.pending;
      this.cachedAt = Date.now();
      return this.cache;
    } finally {
      this.pending = null;
    }
  }

  async list({ limit = 24, offset = 0, type = 'all', q = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number.isInteger(Number(limit)) ? Number(limit) : 24));
    const safeOffset = Math.max(0, Number.isInteger(Number(offset)) ? Number(offset) : 0);
    const normalizedType = String(type || 'all').toLowerCase();
    const query = String(q || '').trim().slice(0, 160).toLocaleLowerCase();
    const { steamRoots, items } = await this.snapshot();
    const matches = items.filter((item) => {
      if (normalizedType !== 'all' && item.type !== normalizedType) return false;
      return !query || item.title.toLocaleLowerCase().includes(query);
    });
    return {
      items: matches.slice(safeOffset, safeOffset + safeLimit).map(({ id, title, type: itemType, playable, reason, hasPreview }) => ({ id, title, type: itemType, playable, reason, hasPreview })),
      total: matches.length,
      offset: safeOffset,
      limit: safeLimit,
      steamFound: steamRoots.length > 0,
    };
  }

  async get(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
    const { items } = await this.snapshot();
    return items.find((item) => item.id === id) ?? null;
  }
}
