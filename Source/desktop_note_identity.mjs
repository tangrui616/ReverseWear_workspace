import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, typographer: false });

export function noteIdentityId(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export function noteTitleFromMarkdown(body, fallback) {
  const tokens = markdown.parse(String(body), {});
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h1') continue;
    const inline = tokens[index + 1];
    const title = (inline?.children ?? []).map(token => {
      if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') return token.content;
      if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
      return '';
    }).join('').trim();
    if (title) return title;
  }
  return fallback;
}
