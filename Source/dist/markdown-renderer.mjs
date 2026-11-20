import MarkdownIt from './vendor/markdown-it/markdown-it.esm.min.mjs';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

function plainInline(tokens) {
  return (tokens ?? []).map(token => token.type === 'image'
    ? token.content
    : token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline'
      ? token.content
      : token.children ? plainInline(token.children) : '').join('');
}

function headingSlug(value) {
  const slug = value.normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'heading';
}

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

markdown.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
  const next = tokens[index + 1];
  const base = headingSlug(plainInline(next?.children));
  const count = (env.headingIds.get(base) ?? 0) + 1;
  env.headingIds.set(base, count);
  tokens[index].attrSet('id', `mdr-${base}${count > 1 ? `-${count}` : ''}`);
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.list_item_open = (tokens, index, options, env, renderer) => {
  const inline = tokens[index + 1]?.type === 'paragraph_open' && tokens[index + 2]?.type === 'inline'
    ? tokens[index + 2] : null;
  const first = inline?.children?.[0]?.type === 'text' ? inline.children[0] : null;
  const match = first?.content.match(/^\[([ xX])\]\s+/);
  if (match) {
    first.content = first.content.slice(match[0].length);
    if (!first.content && inline.children.length > 1) inline.children.shift();
    return `<li class="markdown-content__task-item"><input type="checkbox" disabled${match[1].toLowerCase() === 'x' ? ' checked' : ''}>`;
  }
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet('href') ?? '';
  if (/^https?:\/\//i.test(href)) token.attrSet('rel', 'noreferrer noopener');
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(source) {
  return markdown.render(String(source ?? ''), { headingIds: new Map() });
}

export function renderMarkdownInline(source) {
  return markdown.renderInline(String(source ?? ''));
}

export function setMarkdownContent(container, source, { inline = false } = {}) {
  container.classList.add('markdown-content');
  container.classList.toggle('markdown-content--inline', inline);
  container.innerHTML = inline ? renderMarkdownInline(source) : renderMarkdown(source);
}

export function handleMarkdownLink(event, { openLink, onError = () => {} } = {}) {
  const anchor = event.target?.closest?.('.markdown-content a[href]');
  if (!anchor) return false;
  const root = anchor.closest('.markdown-content');
  const href = anchor.getAttribute('href') ?? '';
  event.preventDefault();
  if (href.startsWith('#')) {
    let targetId;
    try { targetId = decodeURIComponent(href.slice(1)); }
    catch { onError(new Error('此 Markdown 锚点无效。')); return false; }
    const headings = [...root.querySelectorAll('[id]')];
    const target = headings.find(element => element.id === targetId) ??
      headings.find(element => element.id === `mdr-${headingSlug(targetId)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return Boolean(target);
  }
  if (/^https?:\/\//i.test(href)) {
    Promise.resolve().then(() => openLink?.(new URL(href).href)).catch(onError);
    return true;
  }
  onError(new Error('此 Markdown 链接不可用。'));
  return false;
}
