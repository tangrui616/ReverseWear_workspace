import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMarkdownLink, renderMarkdown, renderMarkdownInline } from '../dist/markdown-renderer.mjs';

test('renders common Markdown as readable semantic HTML', () => {
  const html = renderMarkdown('# 中文标题\n\n**重点** 和 *斜体*，~~删除~~，`代码`\n\n- 一\n- 二\n\n> 引用\n\n| 名称 | 值 |\n| --- | --- |\n| 项目 | 可读 |\n\n- [x] 已完成\n- [ ] 待办');
  assert.match(html, /<h1 id="mdr-中文标题">中文标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<s>删除<\/s>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled>/);
});

test('escapes raw HTML and does not create active dangerous links or images', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[jump](javascript:alert(1)) ![remote](https://example.invalid/image.png)');
  assert.doesNotMatch(html, /<script>|<a\b[^>]*javascript:|<img\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /remote/);
});

test('keeps code punctuation, escapes inline text, and renders inline summaries', () => {
  assert.match(renderMarkdown('`** literal *`'), /<code>\*\* literal \*<\/code>/);
  assert.match(renderMarkdownInline('**加粗** & <tag>'), /<strong>加粗<\/strong> &amp; &lt;tag&gt;/);
});

test('creates unique, deterministic heading ids', () => {
  const html = renderMarkdown('# Same\n\n# Same');
  assert.match(html, /id="mdr-same"/);
  assert.match(html, /id="mdr-same-2"/);
});

test('routes only safe external and local fragment links', async () => {
  const calls = [];
  const root = { querySelectorAll: () => [{ id: 'mdr-title', scrollIntoView() { calls.push('anchor'); } }] };
  const anchor = href => ({ getAttribute: () => href, closest: selector => selector === '.markdown-content' ? root : null });
  const event = href => ({ target: { closest: () => anchor(href) }, preventDefault() { calls.push('prevent'); } });
  assert.equal(handleMarkdownLink(event('https://example.com'), { openLink: url => calls.push(url) }), true);
  await Promise.resolve();
  assert.ok(calls.includes('https://example.com/'));
  assert.equal(handleMarkdownLink(event('#mdr-title'), {}), true);
  const errors = [];
  assert.equal(handleMarkdownLink(event('file:///private'), { onError: error => errors.push(error) }), false);
  assert.equal(errors.length, 1);
});
