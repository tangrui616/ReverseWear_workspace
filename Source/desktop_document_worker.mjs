import { parentPort, workerData } from 'node:worker_threads';
import { renderMarkdown } from './dist/markdown-renderer.mjs';

const allowedTags = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];

try {
  const buffer = Buffer.from(workerData.contents);
  let html;
  if (workerData.extension === '.md' || workerData.extension === '.markdown') {
    html = renderMarkdown(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } else {
    const [mammothModule, sanitizeModule] = await Promise.all([
      import('mammoth'), import('sanitize-html'),
    ]);
    const mammoth = mammothModule.default ?? mammothModule;
    const sanitizeHtml = sanitizeModule.default ?? sanitizeModule;
    const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false });
    html = sanitizeHtml(result.value, {
      allowedTags,
      allowedAttributes: {
        a: ['href', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowProtocolRelative: false,
      transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer noopener' }, true) },
    });
  }
  parentPort.postMessage({ ok: true, html });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || '文档解析失败。' });
}
