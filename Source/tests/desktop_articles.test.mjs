import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openArticleStore, validateArticleUrl } from '../desktop_articles.mjs';

const html = '<article><p>Alpha <strong>beta</strong> gamma.</p></article>';
const articleData = {
  title: 'A test article', byline: 'Writer', excerpt: 'alpha beta', siteName: 'Example',
  contentHtml: html, textContent: 'Alpha beta gamma.', markdown: 'Alpha **beta** gamma.',
};

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  const store = await openArticleStore(root, {
    fetchPage: async url => ({ html: '<html>private source</html>', finalUrl: url }),
    extractArticle: async () => articleData,
    now: () => new Date('2026-11-15T10:00:00.000Z'),
  });
  try { await run(store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('URL validation removes fragments and blocks credentials, local and non-web URLs', () => {
  assert.equal(validateArticleUrl('https://example.org/read#part').href, 'https://example.org/read');
  assert.equal(validateArticleUrl('https://[2001:4860:4860:0:0:0:0:8888]/').hostname, '[2001:4860:4860::8888]');
  assert.throws(() => validateArticleUrl('https://[2001:db8::1]/'));
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.org/', 'http://localhost/', 'http://127.0.0.1/', 'http://192.168.1.10/', 'http://[::1]/']) {
    assert.throws(() => validateArticleUrl(url));
  }
});

test('capture deduplicates canonical URL, filters by status/tag and keeps raw and safe content separate', async () => {
  await withStore(async store => {
    const first = await store.capture('https://example.org/read#section', { tags: ['research'] });
    assert.equal(first.duplicate, false);
    assert.equal(first.article.status, 'inbox');
    assert.equal(first.article.contentHtml, html);
    assert.equal(first.article.textContent, 'Alpha beta gamma.');
    assert.equal(first.article.markdownBody, 'Alpha **beta** gamma.');
    const duplicate = await store.capture('https://example.org/read', { tags: ['paper'] });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.article.id, first.article.id);
    assert.deepEqual(new Set(duplicate.article.tags), new Set(['research', 'paper']));
    assert.equal(store.list({ status: 'inbox', tag: 'research' }).length, 1);
    assert.equal(store.list({ status: 'inbox', query: 'Alpha' }).length, 1);
    assert.equal(store.list({ status: 'later' }).length, 0);
    assert.equal(store.transition(first.article.id, 'later').status, 'later');
    assert.equal(store.list({ status: 'later' }).length, 1);
    assert.equal(store.findByUrl('https://example.org/read#other').id, first.article.id);
  });
});

test('highlights require exact textContent UTF-16 offsets; export includes notes', async () => {
  await withStore(async store => {
    const { article } = await store.capture('https://example.org/read');
    assert.throws(() => store.addHighlight(article.id, { quote: 'beta', start: 5, end: 9 }), /不匹配/);
    const highlight = store.addHighlight(article.id, { quote: 'beta', start: 6, end: 10, note: 'Check this claim.' });
    assert.deepEqual([highlight.start, highlight.end], [6, 10]);
    store.addNote(article.id, 'Follow up later.');
    const output = await store.exportMarkdown(article.id);
    assert.match(output, /Alpha \*\*beta\*\* gamma\./);
    assert.match(output, /Check this claim\./);
    assert.match(output, /Follow up later\./);
  });
});

test('capture rejects unsafe target before fetch is invoked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let calls = 0;
  const store = await openArticleStore(root, { fetchPage: async () => { calls++; throw new Error('should not be called'); } });
  try {
    await assert.rejects(store.capture('http://10.0.0.4/'), /不允许/);
    assert.equal(calls, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('optional raster assets are saved locally after MIME and magic validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const store = await openArticleStore(root, {
    fetchPage: async url => ({ html: '<html>source</html>', finalUrl: url }),
    extractArticle: async () => ({ ...articleData, coverUrl: 'https://example.org/cover.png', faviconUrl: '' }),
    fetchAsset: async (_url, { maxBytes }) => ({ data: png, mime: 'image/png', maxBytes }),
  });
  try {
    const { article } = await store.capture('https://example.org/read');
    const asset = store.assetPath(article.id, 'cover');
    assert.equal(asset.mime, 'image/png');
    assert.equal(article.coverUrl, `/api/articles/${article.id}/cover`);
    assert.equal(article.coverAsset.mime, 'image/png');
    const fs = await import('node:fs/promises');
    assert.equal((await fs.stat(asset.path)).size, 12);
    await store.delete(article.id);
    await assert.rejects(fs.stat(asset.path), { code: 'ENOENT' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('capturing an already archived URL returns the saved article without a network retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let failFetch = false;
  let fetches = 0;
  const store = await openArticleStore(root, {
    fetchPage: async url => {
      fetches++;
      if (failFetch) throw new Error('server unavailable');
      return { html: '<html>private source</html>', finalUrl: url };
    },
    extractArticle: async () => articleData,
  });
  try {
    const created = await store.capture('https://example.org/read');
    store.transition(created.article.id, 'archive');
    failFetch = true;
    const reused = await store.capture('https://example.org/read');
    assert.equal(fetches, 1);
    assert.equal(reused.duplicate, true);
    assert.equal(reused.article.status, 'archive');
    assert.equal(reused.article.id, created.article.id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent captures of the same URL coalesce and redirect aliases share one stored record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let release;
  let fetches = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const store = await openArticleStore(root, {
    fetchPage: async url => {
      fetches++;
      await gate;
      return { html: '<html>source</html>', finalUrl: 'https://example.org/canonical' };
    },
    extractArticle: async () => articleData,
  });
  try {
    const first = store.capture('https://example.org/alias-a');
    const concurrent = store.capture('https://example.org/alias-a', { tags: ['shared'] });
    const alias = store.capture('https://example.org/alias-b');
    release();
    const [a, b, c] = await Promise.all([first, concurrent, alias]);
    assert.equal(fetches, 2);
    assert.equal(a.article.id, b.article.id);
    assert.equal(a.article.id, c.article.id);
    assert.equal(b.duplicate, true);
    assert.equal(store.list({ status: 'all' }).length, 1);
    assert.deepEqual(a.article.tags, ['shared']);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Chinese search finds sentence fragments and two-character terms after rebuilding a legacy index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let store = await openArticleStore(root, {
    fetchPage: async url => ({ html: '<html>source</html>', finalUrl: url }),
    extractArticle: async () => ({ ...articleData, textContent: '今天我们讨论具身机器人与控制理论。强化学习是其中方向。',
      contentHtml: '<article><p>今天我们讨论具身机器人与控制理论。强化学习是其中方向。</p></article>',
      markdown: '今天我们讨论具身机器人与控制理论。强化学习是其中方向。' }),
  });
  try {
    const { article } = await store.capture('https://example.org/chinese', { tags: ['研究'] });
    store.close();
    const database = new DatabaseSync(path.join(root, 'articles.sqlite'));
    database.exec(`DROP TABLE articles_fts;
      CREATE VIRTUAL TABLE articles_fts USING fts5(article_id UNINDEXED,title,excerpt,body,tags,tokenize='unicode61');
      INSERT INTO articles_fts(article_id,title,excerpt,body,tags)
      SELECT a.id,a.title,a.excerpt,'今天我们讨论具身机器人与控制理论。强化学习是其中方向。',
        COALESCE((SELECT group_concat(tag,' ') FROM article_tags WHERE article_id=a.id),'') FROM articles a;`);
    database.close();
    store = await openArticleStore(root);
    assert.equal(store.list({ status: 'all', query: '机器人' })[0].id, article.id);
    assert.equal(store.list({ status: 'all', query: '学习' })[0].id, article.id);
    assert.equal(store.list({ status: 'all', query: '机器人 控制' })[0].id, article.id);
    assert.equal(store.list({ status: 'all', tag: '研究', query: '机器人' })[0].id, article.id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('new article reading time counts Han characters and non-Han words', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  const chinese = '汉'.repeat(1200);
  let store = await openArticleStore(root, {
    fetchPage: async url => ({ html: '<html>source</html>', finalUrl: url }),
    extractArticle: async (_html, url) => url.includes('english')
      ? ({ ...articleData, textContent: Array(500).fill('word').join(' '), contentHtml: '<p>English</p>', markdown: 'English' })
      : ({ ...articleData, textContent: chinese, contentHtml: `<p>${chinese}</p>`, markdown: chinese }),
  });
  try {
    const { article } = await store.capture('https://example.org/chinese-reading');
    assert.equal(article.readingMinutes, 3);
    const english = await store.capture('https://example.org/english-reading');
    assert.equal(english.article.readingMinutes, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('article deletion journals file cleanup and retries it on next open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let store = await openArticleStore(root, {
    fetchPage: async url => ({ html: '<html>private source</html>', finalUrl: url }),
    extractArticle: async () => articleData,
  });
  try {
    const { article } = await store.capture('https://example.org/delete');
    const sourcePath = path.join(root, 'raw', `${article.id}.source.html`);
    await rm(sourcePath);
    await mkdir(sourcePath);
    await writeFile(path.join(sourcePath, 'locked.txt'), 'force unlink failure');
    assert.deepEqual(await store.delete(article.id), { deleted: true, cleanupPending: true });
    assert.equal(store.get(article.id), null);
    await rm(sourcePath, { recursive: true, force: true });
    store.close();
    store = await openArticleStore(root);
    const database = new DatabaseSync(path.join(root, 'articles.sqlite'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM article_file_cleanup').get().count, 0);
    database.close();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('shutdown cancels queued and network captures before closing the database', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  let started = 0;
  const store = await openArticleStore(root, {
    fetchPage: (url, { signal }) => new Promise((_resolve, reject) => {
      started++;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    extractArticle: async () => articleData,
  });
  const captures = Array.from({ length: 4 }, (_, index) =>
    store.capture(`https://example.org/queued-${index}`).catch(error => error));
  try {
    while (started < 3) await new Promise(resolve => setImmediate(resolve));
    await store.shutdown();
    const outcomes = await Promise.all(captures);
    assert.equal(started, 3);
    assert.ok(outcomes.every(outcome => outcome instanceof Error));
    assert.throws(() => store.list({ status: 'all' }), /closed database|not open/i);
  } finally { await new Promise(resolve => setTimeout(resolve, 50)); await rm(root, { recursive: true, force: true }); }
});

test('startup removes only article-owned pending files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  await mkdir(path.join(root, 'raw'), { recursive: true });
  await mkdir(path.join(root, 'articles'), { recursive: true });
  const id = randomUUID();
  const ownedPending = path.join(root, 'articles', `${id}.md.pending`);
  const unrelatedPending = path.join(root, 'articles', 'external-export.md.pending');
  await writeFile(ownedPending, 'incomplete');
  await writeFile(unrelatedPending, 'keep');
  const store = await openArticleStore(root);
  try {
    assert.ok(!(await readdir(path.join(root, 'articles'))).includes(`${id}.md.pending`));
    assert.ok((await readdir(path.join(root, 'articles'))).includes('external-export.md.pending'));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Windows directory case aliases are accepted while normal paths still open', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-articles-'));
  const alias = root.toUpperCase();
  const store = await openArticleStore(alias);
  try { assert.deepEqual(store.list({ status: 'all' }), []); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
