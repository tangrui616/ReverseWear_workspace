import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, lstat, realpath, rename, rm, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12000;
const MAX_CAPTURE_CONCURRENCY = 3;
const MAX_CAPTURE_QUEUE = 8;
const STATUSES = new Set(['inbox', 'later', 'archive']);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bareHostname = url => url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

function decodeHtml(buffer, contentType) {
  const headerCharset = String(contentType || '').match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  const prefix = buffer.subarray(0, 4096).toString('latin1');
  const metaCharset = prefix.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1]
    || prefix.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([^\s"';]+)/i)?.[1];
  const charset = headerCharset || metaCharset || 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(buffer); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buffer); }
}

function ipIsPublic(value) {
  const family = net.isIP(value);
  if (!family) return false;
  if (family === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a === 255);
  }
  const normalized = value.toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')) return false;
  // Only accept the global-unicast 2000::/3 space. Expand enough hextets to
  // reject special 2001 ranges and 6to4, which can encode an IPv4 destination.
  const parts = normalized.split('::');
  if (parts.length > 2) return false;
  const [left = '', right] = parts;
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (parts.length === 2 && missing < 1) return false;
  const groups = parts.length === 1 ? leftGroups : [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
  if (groups.length !== 8) return false;
  const first = Number.parseInt(groups[0], 16);
  const second = Number.parseInt(groups[1], 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
  if (first === 0x2002) return false;
  return true;
}

export function validateArticleUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 网页。');
  if (url.username || url.password) throw new Error('网址不能包含用户名或密码。');
  const host = bareHostname(url);
  if (!host || host.endsWith('.localhost') || host === 'localhost') throw new Error('不允许访问本机地址。');
  if (net.isIP(host) && !ipIsPublic(host)) throw new Error('不允许访问本地或保留 IP 地址。');
  url.hash = '';
  return url;
}

async function resolvePublic(hostname) {
  hostname = String(hostname).replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (!ipIsPublic(hostname)) throw new Error('目标地址不是可公开访问的 IP。');
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('无法解析目标网站地址。'); }
  if (!records.length || records.some(record => !ipIsPublic(record.address))) throw new Error('目标域名解析到本机、内网或保留地址，已阻止访问。');
  return records;
}

function requestOnce(url, records, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinned = [...records];
    const req = requester(url, {
      method: 'GET',
      headers: { 'user-agent': 'ReverseWear-ArticleReader/1.0', accept: 'text/html,application/xhtml+xml;q=0.9', 'accept-encoding': 'identity' },
      timeout: FETCH_TIMEOUT_MS,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, pinned);
        else callback(null, pinned[0].address, pinned[0].family);
      },
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        resolve({ status, location: response.headers.location || '' });
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); reject(new Error(`网页返回 HTTP ${status || '未知状态'}。`)); return; }
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) { response.resume(); reject(new Error('目标内容不是 HTML 网页。')); return; }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_PAGE_BYTES) { req.destroy(new Error('网页超过 5 MiB 上限。')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status, html: decodeHtml(data, type), contentType: type, byteLength: data.length });
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('网页读取超时。')));
    req.on('error', reject);
    const abort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('文章抓取已取消。'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const wallTimer = setTimeout(() => req.destroy(new Error('网页读取超时。')), FETCH_TIMEOUT_MS);
    req.once('close', () => {
      clearTimeout(wallTimer);
      signal?.removeEventListener('abort', abort);
    });
    req.end();
  });
}

const IMAGE_TYPES = new Map([
  ['image/png', { ext: 'png', mime: 'image/png' }], ['image/jpeg', { ext: 'jpg', mime: 'image/jpeg' }],
  ['image/gif', { ext: 'gif', mime: 'image/gif' }], ['image/webp', { ext: 'webp', mime: 'image/webp' }],
  ['image/x-icon', { ext: 'ico', mime: 'image/x-icon' }], ['image/vnd.microsoft.icon', { ext: 'ico', mime: 'image/x-icon' }],
]);

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return IMAGE_TYPES.get('image/png');
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return IMAGE_TYPES.get('image/jpeg');
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return IMAGE_TYPES.get('image/gif');
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return IMAGE_TYPES.get('image/webp');
  if (buffer.length >= 8 && buffer.readUInt16LE(0) === 0 && [1, 2].includes(buffer.readUInt16LE(2))) return IMAGE_TYPES.get('image/x-icon');
  return null;
}

async function fetchPublicImage(input, { maxBytes = MAX_ASSET_BYTES, signal } = {}) {
  let url = validateArticleUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const records = await resolvePublic(url.hostname);
    const result = await new Promise((resolve, reject) => {
      const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const pinned = [...records];
      const req = requester(url, {
        method: 'GET', headers: { 'user-agent': 'ReverseWear-ArticleReader/1.0', accept: 'image/png,image/jpeg,image/gif,image/webp,image/x-icon;q=0.8', 'accept-encoding': 'identity' },
        lookup(_hostname, options, callback) { if (options?.all) callback(null, pinned); else callback(null, pinned[0].address, pinned[0].family); },
      }, response => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) { response.resume(); resolve({ status, location: response.headers.location || '' }); return; }
        if (status < 200 || status >= 300) { response.resume(); reject(new Error('图像服务器返回错误状态。')); return; }
        const mime = IMAGE_TYPES.get(String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase());
        if (!mime) { response.resume(); reject(new Error('只保存 PNG、JPEG、GIF、WebP 或 ICO 图像。')); return; }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(new Error('图像超过 2 MiB 上限。')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          const detected = detectImage(data);
          if (!detected || detected.mime !== mime.mime) { reject(new Error('图像内容与 MIME 类型不匹配。')); return; }
          resolve({ data, ...detected });
        });
        response.on('error', reject);
      });
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('图像读取超时。')));
      req.on('error', reject);
      const abort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('文章抓取已取消。'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const wallTimer = setTimeout(() => req.destroy(new Error('图像读取超时。')), FETCH_TIMEOUT_MS);
      req.once('close', () => {
        clearTimeout(wallTimer);
        signal?.removeEventListener('abort', abort);
      });
      req.end();
    });
    if (result.data) return result;
    if (!result.location) throw new Error('图像重定向地址无效。');
    if (redirect === MAX_REDIRECTS) throw new Error('图像重定向次数过多。');
    url = validateArticleUrl(new URL(result.location, url).href);
  }
  throw new Error('图像读取失败。');
}

export async function fetchPublicArticlePage(input, { signal } = {}) {
  let url = validateArticleUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const records = await resolvePublic(url.hostname);
    const result = await requestOnce(url, records, { signal });
    if (result.html !== undefined) return { html: result.html, finalUrl: url.href, contentType: result.contentType, byteLength: result.byteLength };
    if (!result.location) throw new Error('网页重定向地址无效。');
    if (redirect === MAX_REDIRECTS) throw new Error('网页重定向次数过多。');
    url = validateArticleUrl(new URL(result.location, url).href);
  }
  throw new Error('网页读取失败。');
}

async function defaultExtract(html, url) {
  const [{ parseHTML }, readability, turndownModule, sanitizeModule] = await Promise.all([
    import('linkedom'), import('@mozilla/readability'), import('turndown'), import('sanitize-html'),
  ]);
  const source = /<html(?:\s|>)/i.test(html) ? html : '<!doctype html><html><head></head><body>' + html + '</body></html>';
  const { document } = parseHTML(source);
  const metaContent = selector => String(document.querySelector(selector)?.getAttribute('content') || '').trim();
  const titleFallback = metaContent('meta[property="og:title"]') || String(document.title || document.querySelector('title')?.textContent || '').trim();
  const descriptionFallback = metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]');
  const siteNameFallback = metaContent('meta[property="og:site_name"]');
  const coverUrl = metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');
  const faviconUrl = String(document.querySelector('link[rel~="icon"]')?.getAttribute('href') || '/favicon.ico').trim();
  let head = document.querySelector('head');
  if (!head) { head = document.createElement('head'); document.documentElement?.prepend(head); }
  let base = head.querySelector('base');
  if (!base) { base = document.createElement('base'); head.prepend(base); }
  base.setAttribute('href', url);
  const Reader = readability.Readability || readability.default?.Readability;
  let article;
  try { article = new Reader(document, { url }).parse(); }
  catch { /* Try the original static document below. */ }
  if (!article?.content) {
    const { document: original } = parseHTML(source);
    for (const node of original.querySelectorAll('script,style,nav,footer,header,aside,form,noscript,iframe')) node.remove();
    const body = original.querySelector('article,main,[role="main"]') || original.querySelector('body');
    if ((body?.textContent || '').trim().length < 80) throw new Error('未能从网页提取正文。');
    article = { content: body.innerHTML };
  }
  const sanitize = sanitizeModule.default || sanitizeModule;
  const safeHtml = sanitize(article.content, {
    allowedTags: sanitize.defaults.allowedTags.concat(['h1', 'h2', 'figure', 'figcaption']).filter(tag => tag !== 'img'),
    allowedAttributes: { a: ['href', 'title'], '*': ['class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
  const Turndown = turndownModule.default || turndownModule;
  const markdown = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', linkStyle: 'inlined' }).turndown(safeHtml).trim();
  const { document: safeDocument } = parseHTML(`<div id="article-text">${safeHtml}</div>`);
  return {
    title: String(article.title || titleFallback || '').trim().slice(0, 500),
    byline: String(article.byline || '').trim().slice(0, 500),
    excerpt: String(article.excerpt || descriptionFallback || '').trim().slice(0, 2000),
    contentHtml: safeHtml, textContent: safeDocument.querySelector('#article-text')?.textContent || '', markdown,
    siteName: String(article.siteName || siteNameFallback || '').slice(0, 200), coverUrl, faviconUrl,
  };
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  return [...new Set(values.map(tag => String(tag).trim().replace(/[\r\n\0]/g, '').slice(0, 80)).filter(Boolean))].slice(0, 30);
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('文章标识无效。');
  return value;
}

function readingWordEquivalent(text) {
  const value = String(text || '');
  const hanCount = [...value.matchAll(/\p{Script=Han}/gu)].length;
  const remaining = value.replace(/\p{Script=Han}/gu, ' ');
  const otherWords = (remaining.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
  // The stored count is in 250-per-minute word units so legacy rows and readers remain compatible.
  return Math.ceil(hanCount * (250 / 400) + otherWords);
}

function articleRow(row, tags) {
  if (!row) return null;
  const coverUrl = row.cover_path ? `/api/articles/${row.id}/cover` : '';
  const iconUrl = row.icon_path ? `/api/articles/${row.id}/icon` : '';
  return {
    id: row.id, url: row.url, canonicalUrl: row.canonical_url, title: row.title,
    byline: row.byline, excerpt: row.excerpt, domain: row.domain, siteName: row.site_name,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    markdownPath: row.markdown_path, coverUrl, coverMime: row.cover_mime || '',
    faviconUrl: iconUrl, iconUrl, iconMime: row.icon_mime || '',
    coverAsset: coverUrl ? { url: coverUrl, mime: row.cover_mime } : null,
    iconAsset: iconUrl ? { url: iconUrl, mime: row.icon_mime } : null,
    readingMinutes: Math.max(1, Math.ceil((Number(row.word_count) || 0) / 250)),
    tags: tags || [], contentHash: row.content_hash,
  };
}

async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文章存储目录必须是普通目录。');
  const actual = await realpath(absolute);
  if (process.platform === 'win32' ? actual.toLowerCase() !== absolute.toLowerCase() : actual !== absolute) {
    throw new Error('文章存储目录解析路径异常。');
  }
  return absolute;
}

async function ensureChildDirectory(root, name) {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  const actual = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform === 'win32' ? actual.toLowerCase() !== target.toLowerCase() : actual !== target)) {
    throw new Error('文章子目录必须是存储目录中的普通目录。');
  }
  return target;
}

export async function openArticleStore(root, { fetchPage = fetchPublicArticlePage, fetchAsset = fetchPublicImage, extractArticle = defaultExtract, sanitizeMarkup, now = () => new Date() } = {}) {
  const directory = await ensurePrivateDirectory(root);
  const rawDirectory = await ensureChildDirectory(directory, 'raw');
  const markdownDirectory = await ensureChildDirectory(directory, 'articles');
  const assetDirectory = await ensureChildDirectory(directory, 'assets');
  const databasePath = path.join(directory, 'articles.sqlite');
  try {
    const dbInfo = await lstat(databasePath);
    if (!dbInfo.isFile() || dbInfo.isSymbolicLink() || await realpath(databasePath) !== databasePath) throw new Error('文章数据库路径必须是普通文件。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, canonical_url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, byline TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL, site_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('inbox','later','archive')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_path TEXT NOT NULL,
      markdown_path TEXT NOT NULL, content_path TEXT NOT NULL DEFAULT '', text_path TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', favicon_url TEXT NOT NULL DEFAULT '', word_count INTEGER NOT NULL DEFAULT 0, cover_path TEXT NOT NULL DEFAULT '', cover_mime TEXT NOT NULL DEFAULT '', icon_path TEXT NOT NULL DEFAULT '', icon_mime TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS article_tags (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(article_id,tag));
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('highlight','note')), quote TEXT NOT NULL DEFAULT '',
      start_offset INTEGER, end_offset INTEGER, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS article_file_cleanup (article_id TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE);
  `);
  const ftsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='articles_fts'").get()?.sql || '';
  if (!ftsSql) {
    database.exec("CREATE VIRTUAL TABLE articles_fts USING fts5(article_id UNINDEXED,title,excerpt,body,tags, tokenize='trigram')");
  } else if (!/tokenize\s*=\s*'trigram'/i.test(ftsSql)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec("CREATE VIRTUAL TABLE articles_fts_v19 USING fts5(article_id UNINDEXED,title,excerpt,body,tags, tokenize='trigram')");
      database.exec('INSERT INTO articles_fts_v19(article_id,title,excerpt,body,tags) SELECT article_id,title,excerpt,body,tags FROM articles_fts');
      database.exec('DROP TABLE articles_fts');
      database.exec('ALTER TABLE articles_fts_v19 RENAME TO articles_fts');
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  const getTags = database.prepare('SELECT tag FROM article_tags WHERE article_id=? ORDER BY tag COLLATE NOCASE');
  const selectArticle = database.prepare('SELECT * FROM articles WHERE id=?');
  const listAnnotations = database.prepare('SELECT id,kind,quote,start_offset AS start,end_offset AS end,note,created_at AS createdAt FROM annotations WHERE article_id=? ORDER BY created_at,id');
  const insertTag = database.prepare('INSERT OR IGNORE INTO article_tags(article_id,tag) VALUES(?,?)');
  const pendingCaptures = new Map();
  const captureControllers = new Map();
  let activeCaptures = 0;
  const captureQueue = [];
  let shuttingDown = false;
  let closed = false;
  const nowIso = () => now().toISOString();

  async function sweepAbandonedPendingFiles() {
    const pendingName = /^[a-f0-9-]{36}\.(?:source\.html|md|safe\.html|text\.txt)\.pending$/i;
    for (const directoryPath of [rawDirectory, markdownDirectory]) {
      for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
        if (entry.isFile() && pendingName.test(entry.name)) {
          await rm(path.join(directoryPath, entry.name), { force: true }).catch(() => {});
        }
      }
    }
  }

  await sweepAbandonedPendingFiles();

  function safeArticleFiles(id, row) {
    const files = [];
    const add = (relative, expectedDirectory, expectedName, storedPath = expectedName) => {
      if (!relative) return;
      const candidate = String(relative);
      if (candidate !== storedPath || path.basename(candidate) !== expectedName) {
        throw new Error('文章文件记录路径异常，未执行删除。');
      }
      files.push({ relativePath: path.relative(directory, path.join(expectedDirectory, expectedName)) });
    };
    add(row.source_path, rawDirectory, `${id}.source.html`);
    add(row.markdown_path, markdownDirectory, `${id}.md`);
    add(row.content_path, markdownDirectory, `${id}.safe.html`, path.relative(directory, path.join(markdownDirectory, `${id}.safe.html`)));
    add(row.text_path, markdownDirectory, `${id}.text.txt`, path.relative(directory, path.join(markdownDirectory, `${id}.text.txt`)));
    for (const [field, suffix] of [['cover_path', 'cover'], ['icon_path', 'icon']]) {
      const name = row[field];
      if (!name) continue;
      if (typeof name !== 'string') throw new Error('文章附件记录路径异常，未执行删除。');
      const extension = name.match(/\.(png|jpg|gif|webp|ico)$/i)?.[0] || '';
      if (name !== path.basename(name) || !extension ||
          name.toLowerCase() !== `${id}.${suffix}${extension}`.toLowerCase()) {
        throw new Error('文章附件记录路径异常，未执行删除。');
      }
      files.push({ relativePath: path.relative(directory, path.join(assetDirectory, name)) });
    }
    return files;
  }

  async function retryFileCleanup() {
    const rows = database.prepare('SELECT article_id,relative_path FROM article_file_cleanup ORDER BY article_id,relative_path').all();
    const removeCleanup = database.prepare('DELETE FROM article_file_cleanup WHERE relative_path=?');
    for (const row of rows) {
      const target = path.resolve(directory, row.relative_path);
      const relative = path.relative(directory, target);
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      const allowed = [rawDirectory, markdownDirectory, assetDirectory].some(root => {
        const contained = path.relative(root, target);
        return contained && !contained.startsWith('..' + path.sep) && !path.isAbsolute(contained);
      });
      if (!allowed) continue;
      try {
        await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        removeCleanup.run(row.relative_path);
      } catch { /* Retain the journal row and retry on the next open or delete call. */ }
    }
  }

  await retryFileCleanup();

  async function withCaptureSlot({ signal, run }) {
    if (shuttingDown) throw new Error('文章收集箱正在关闭。');
    if (activeCaptures >= MAX_CAPTURE_CONCURRENCY) {
      if (captureQueue.length >= MAX_CAPTURE_QUEUE) throw new Error('文章抓取队列已满，请稍后重试。');
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, abort: null };
        entry.abort = () => {
          const index = captureQueue.indexOf(entry);
          if (index >= 0) captureQueue.splice(index, 1);
          reject(new Error('文章抓取已取消。'));
        };
        if (signal?.aborted) { entry.abort(); return; }
        signal?.addEventListener('abort', entry.abort, { once: true });
        captureQueue.push(entry);
      });
    }
    if (signal?.aborted || shuttingDown) throw new Error('文章抓取已取消。');
    activeCaptures++;
    try { return await run(); }
    finally {
      activeCaptures--;
      const entry = captureQueue.shift();
      if (entry) {
        entry.signal?.removeEventListener('abort', entry.abort);
        entry.resolve();
      }
    }
  }

  function get(id) {
    const row = selectArticle.get(safeId(id));
    if (!row) return null;
    const article = { ...articleRow(row, getTags.all(row.id).map(item => item.tag)), annotations: listAnnotations.all(row.id) };
    const safeFile = row.content_path && path.join(directory, row.content_path);
    const textFile = row.text_path && path.join(directory, row.text_path);
    article.contentHtml = safeFile ? readFileSync(safeFile, 'utf8') : '';
    article.textContent = textFile ? readFileSync(textFile, 'utf8') : '';
    const markdownFile = row.markdown_path && path.join(markdownDirectory, row.markdown_path);
    article.markdownBody = markdownFile ? readFileSync(markdownFile, 'utf8').replace(/^# .*?\r?\n\r?\n/s, '').replace(/\r?\n$/, '') : '';
    article.body = article.markdownBody;
    return article;
  }

  function getByUrl(url, fallbackUrl = url) {
    return database.prepare('SELECT id FROM articles WHERE canonical_url=? OR url=? OR canonical_url=? OR url=?')
      .get(url, url, fallbackUrl, fallbackUrl);
  }

  function addTagsAndTouch(id, tags) {
    for (const tag of normalizeTags(tags)) insertTag.run(id, tag);
    const allTags = getTags.all(id).map(item => item.tag);
    database.prepare('UPDATE articles_fts SET tags=? WHERE article_id=?').run(allTags.join(' '), id);
    database.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(nowIso(), id);
    return get(id);
  }

  async function capture(suppliedUrl, options = {}) {
    if (shuttingDown) throw new Error('文章收集箱正在关闭。');
    const safeUrl = validateArticleUrl(suppliedUrl);
    const cached = getByUrl(safeUrl.href);
    if (cached) return { article: addTagsAndTouch(cached.id, options.tags), duplicate: true };
    const active = pendingCaptures.get(safeUrl.href);
    if (active) {
      const result = await active;
      if (options.tags?.length) result.article = addTagsAndTouch(result.article.id, options.tags);
      return { article: result.article, duplicate: true };
    }
    const controller = new AbortController();
    const pending = withCaptureSlot({ signal: controller.signal, run: () => captureFresh(safeUrl, options, controller.signal) });
    pendingCaptures.set(safeUrl.href, pending);
    captureControllers.set(pending, controller);
    try { return await pending; }
    finally {
      if (pendingCaptures.get(safeUrl.href) === pending) pendingCaptures.delete(safeUrl.href);
      captureControllers.delete(pending);
    }
  }

  async function captureFresh(safeUrl, { tags = [] } = {}, signal) {
    const fetched = await fetchPage(safeUrl.href, { signal });
    if (!fetched || typeof fetched.html !== 'string' || Number(fetched.byteLength ?? Buffer.byteLength(fetched.html, 'utf8')) > MAX_PAGE_BYTES) throw new Error('网页内容为空或超过大小限制。');
    const finalUrl = validateArticleUrl(fetched.finalUrl || safeUrl.href);
    const existing = getByUrl(finalUrl.href, safeUrl.href);
    if (existing) return { article: addTagsAndTouch(existing.id, tags), duplicate: true };
    const parsed = await extractArticle(fetched.html, finalUrl.href);
    if (!parsed || typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) throw new Error('网页正文为空，未创建文章。');
    let markdown = parsed.markdown.trim();
    let contentHtml = typeof parsed.contentHtml === 'string' ? parsed.contentHtml : '';
    if (sanitizeMarkup) contentHtml = await sanitizeMarkup(contentHtml, finalUrl.href);
    const title = String(parsed.title || bareHostname(finalUrl)).replace(/[\r\n\0]/g, ' ').trim().slice(0, 500) || bareHostname(finalUrl);
    const id = randomUUID();
    const sourceName = `${id}.source.html`;
    const markdownName = `${id}.md`;
    const safeHtmlName = `${id}.safe.html`;
    const textName = `${id}.text.txt`;
    const sourcePath = path.join(rawDirectory, sourceName);
    const markdownPath = path.join(markdownDirectory, markdownName);
    const safeHtmlPath = path.join(markdownDirectory, safeHtmlName);
    const textPath = path.join(markdownDirectory, textName);
    const sourceTemp = `${sourcePath}.pending`;
    const mdTemp = `${markdownPath}.pending`;
    const safeTemp = `${safeHtmlPath}.pending`;
    const textTemp = `${textPath}.pending`;
    const plainText = typeof parsed.textContent === 'string' ? parsed.textContent : await extractTextContent(contentHtml);
    const assetFiles = [];
    async function storeAsset(kind, rawUrl) {
      const assetUrl = validateOptionalAssetUrl(rawUrl, finalUrl);
      if (!assetUrl) return { path: '', mime: '' };
      try {
        const image = await fetchAsset(assetUrl, { maxBytes: MAX_ASSET_BYTES, signal });
        if (!image?.data || !Buffer.isBuffer(image.data) || image.data.length > MAX_ASSET_BYTES) return { path: '', mime: '' };
        const detected = detectImage(image.data);
        if (!detected || detected.mime !== image.mime) return { path: '', mime: '' };
        const name = `${id}.${kind}.${detected.ext}`;
        const fullPath = path.join(assetDirectory, name);
        await writeFile(fullPath, image.data, { flag: 'wx', mode: 0o600 });
        assetFiles.push(fullPath);
        return { path: name, mime: detected.mime };
      } catch { return { path: '', mime: '' }; }
    }
    const [cover, icon] = await Promise.all([storeAsset('cover', parsed.coverUrl), storeAsset('icon', parsed.faviconUrl)]);
    if (signal?.aborted || shuttingDown) {
      await Promise.all(assetFiles.map(file => rm(file, { force: true })));
      throw new Error('文章抓取已取消。');
    }
    const created = nowIso();
    const hash = sha256(markdown);
    try {
      await writeFile(sourceTemp, fetched.html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(mdTemp, `# ${title}\n\n${markdown}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(safeTemp, contentHtml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await writeFile(textTemp, plainText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(sourceTemp, sourcePath);
      await rename(mdTemp, markdownPath);
      await rename(safeTemp, safeHtmlPath);
      await rename(textTemp, textPath);
      database.exec('BEGIN IMMEDIATE');
      database.prepare(`INSERT INTO articles(id,url,canonical_url,title,byline,excerpt,domain,site_name,status,created_at,updated_at,source_path,markdown_path,content_path,text_path,content_hash,cover_url,favicon_url,word_count,cover_path,cover_mime,icon_path,icon_mime)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, safeUrl.href, finalUrl.href, title,
        String(parsed.byline || '').slice(0, 500), String(parsed.excerpt || '').slice(0, 2000), bareHostname(finalUrl),
        String(parsed.siteName || '').slice(0, 200), 'inbox', created, created, sourceName, markdownName,
        path.join('articles', safeHtmlName), path.join('articles', textName), hash,
        validateOptionalAssetUrl(parsed.coverUrl, finalUrl), validateOptionalAssetUrl(parsed.faviconUrl, finalUrl), readingWordEquivalent(plainText),
        cover.path, cover.mime, icon.path, icon.mime);
      for (const tag of normalizeTags(tags)) insertTag.run(id, tag);
      const tagsText = normalizeTags(tags).join(' ');
      database.prepare('INSERT INTO articles_fts(article_id,title,excerpt,body,tags) VALUES(?,?,?,?,?)').run(id, title, String(parsed.excerpt || ''), markdown, tagsText);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      await Promise.all([sourceTemp, mdTemp, safeTemp, textTemp, sourcePath, markdownPath, safeHtmlPath, textPath, ...assetFiles].map(file => rm(file, { force: true })));
      const concurrent = getByUrl(finalUrl.href, safeUrl.href);
      if (concurrent) return { article: addTagsAndTouch(concurrent.id, tags), duplicate: true };
      throw error;
    }
    return { article: get(id), duplicate: false };
  }

  function validateOptionalAssetUrl(value, base) {
    if (!value) return '';
    try {
      const url = validateArticleUrl(new URL(value, base).href);
      return url.href;
    } catch { return ''; }
  }

  async function extractTextContent(html) {
    if (!html) return '';
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(`<div id="article-text">${html}</div>`);
    return document.querySelector('#article-text')?.textContent || '';
  }

  function list({ status = 'inbox', query = '', tag = '', domain = '', limit = 50, offset = 0 } = {}) {
    if (!STATUSES.has(status) && status !== 'all') throw new Error('文章状态无效。');
    const size = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
    const start = Math.max(0, Math.trunc(Number(offset) || 0));
    const where = [];
    const params = [];
    if (status !== 'all') { where.push('a.status=?'); params.push(status); }
    if (domain) { where.push('a.domain=?'); params.push(String(domain).toLowerCase()); }
    if (tag) { where.push('EXISTS(SELECT 1 FROM article_tags t WHERE t.article_id=a.id AND t.tag=?)'); params.push(String(tag)); }
    const search = String(query).trim();
    let from = 'articles a';
    if (search) {
      from = 'articles_fts f JOIN articles a ON a.id=f.article_id';
      const terms = search.replace(/["*:^{}()\[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const indexed = terms.filter(term => [...term].length >= 3);
      const short = terms.filter(term => [...term].length < 3);
      if (indexed.length) {
        where.push('articles_fts MATCH ?');
        params.push(indexed.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND '));
      }
      for (const term of short) {
        const pattern = `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`;
        where.push("(f.title LIKE ? ESCAPE '\\' OR f.excerpt LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\' OR f.tags LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern, pattern);
      }
    }
    const rows = database.prepare(`SELECT a.* FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`).all(...params, size, start);
    return rows.map(row => articleRow(row, getTags.all(row.id).map(item => item.tag)));
  }

  function transition(id, status) {
    safeId(id);
    if (!STATUSES.has(status)) throw new Error('文章状态无效。');
    const result = database.prepare('UPDATE articles SET status=?,updated_at=? WHERE id=?').run(status, nowIso(), id);
    if (!result.changes) return null;
    return get(id);
  }

  function setTags(id, tags) {
    safeId(id);
    if (!selectArticle.get(id)) return null;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM article_tags WHERE article_id=?').run(id);
      const normalized = normalizeTags(tags);
      for (const tag of normalized) insertTag.run(id, tag);
      database.prepare('UPDATE articles_fts SET tags=? WHERE article_id=?').run(normalized.join(' '), id);
      database.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(nowIso(), id);
      database.exec('COMMIT');
      return get(id);
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }

  function addHighlight(id, { quote, start, end, note = '' } = {}) {
    safeId(id);
    const article = selectArticle.get(id);
    if (!article) return null;
    const body = readFileSync(path.join(directory, article.text_path), 'utf8');
    const exactQuote = String(quote ?? '');
    let from = start, to = end;
    if (from === undefined && to === undefined && exactQuote) {
      const location = body.indexOf(exactQuote);
      if (location >= 0 && body.indexOf(exactQuote, location + 1) === -1) {
        from = location;
        to = location + exactQuote.length;
      }
    }
    if (!exactQuote || exactQuote.length > 32000 || !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to <= from || to > body.length || body.slice(from, to) !== exactQuote) {
      throw new Error('所选原文与文章正文位置不匹配。');
    }
    const annotationId = randomUUID();
    database.prepare(`INSERT INTO annotations(id,article_id,kind,quote,start_offset,end_offset,note,created_at) VALUES(?,?,'highlight',?,?,?,?,?)`)
      .run(annotationId, id, exactQuote, from, to, String(note).slice(0, 5000), nowIso());
    database.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(nowIso(), id);
    return get(id).annotations.find(item => item.id === annotationId);
  }

  function addNote(id, text) {
    safeId(id);
    if (!selectArticle.get(id)) return null;
    const content = String(text ?? '').trim();
    if (!content) throw new Error('笔记内容不能为空。');
    const annotationId = randomUUID();
    database.prepare(`INSERT INTO annotations(id,article_id,kind,quote,start_offset,end_offset,note,created_at) VALUES(?,?,'note','',NULL,NULL,?,?)`)
      .run(annotationId, id, content.slice(0, 20000), nowIso());
    database.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(nowIso(), id);
    return get(id).annotations.find(item => item.id === annotationId);
  }

  function removeAnnotation(id, annotationId) {
    safeId(id);
    const result = database.prepare('DELETE FROM annotations WHERE article_id=? AND id=?').run(id, String(annotationId));
    if (result.changes) database.prepare('UPDATE articles SET updated_at=? WHERE id=?').run(nowIso(), id);
    return Boolean(result.changes);
  }

  async function exportMarkdown(id) {
    const article = get(id);
    if (!article) return null;
    const body = await readFile(path.join(markdownDirectory, article.markdownPath), 'utf8');
    const notes = article.annotations.map(item => item.kind === 'highlight'
      ? `> ${item.quote.replace(/\n/g, '\n> ')}${item.note ? `\n\n${item.note}` : ''}`
      : item.note).filter(Boolean);
    return `${body.trim()}${notes.length ? `\n\n## 阅读批注\n\n${notes.join('\n\n')}` : ''}\n`;
  }

  async function remove(id) {
    safeId(id);
    const row = selectArticle.get(id);
    if (!row) return false;
    const files = safeArticleFiles(id, row);
    database.exec('BEGIN IMMEDIATE');
    try {
      const recordCleanup = database.prepare('INSERT OR IGNORE INTO article_file_cleanup(article_id,relative_path) VALUES(?,?)');
      for (const file of files) recordCleanup.run(id, file.relativePath);
      database.prepare('DELETE FROM articles_fts WHERE article_id=?').run(id);
      database.prepare('DELETE FROM articles WHERE id=?').run(id);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    await retryFileCleanup();
    const pending = database.prepare('SELECT 1 AS pending FROM article_file_cleanup WHERE article_id=? LIMIT 1').get(id);
    return pending ? { deleted: true, cleanupPending: true } : true;
  }

  function close() {
    if (closed) return;
    closed = true;
    shuttingDown = true;
    database.close();
  }

  async function shutdown() {
    if (closed) return;
    shuttingDown = true;
    for (const controller of captureControllers.values()) controller.abort(new Error('文章收集箱正在关闭。'));
    await Promise.allSettled([...captureControllers.keys()]);
    close();
  }
  function findByUrl(input) {
    const url = validateArticleUrl(input);
    const row = database.prepare('SELECT id FROM articles WHERE canonical_url=? OR url=?').get(url.href, url.href);
    return row ? get(row.id) : null;
  }
  function assetPath(id, kind) {
    safeId(id);
    if (!['cover', 'icon'].includes(kind)) throw new Error('仅支持文章封面或图标资源。');
    const row = selectArticle.get(id);
    if (!row) return null;
    const name = kind === 'cover' ? row.cover_path : row.icon_path;
    const mime = kind === 'cover' ? row.cover_mime : row.icon_mime;
    return name && mime ? { path: path.join(assetDirectory, name), mime } : null;
  }
  return { capture, list, get, findByUrl, assetPath, transition, setTags, addHighlight, addNote, removeAnnotation, exportMarkdown, delete: remove, close, shutdown };
}
