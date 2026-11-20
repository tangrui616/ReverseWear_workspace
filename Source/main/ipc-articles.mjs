import { dialog, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { isSensitive } from '../desktop_suite/clipboardService.mjs';
import { checkExternalLink } from './external-link.mjs';
import { sendEvent } from './ipc.mjs';

/** @param {import('./ipc.mjs').RegisterHandler} register */
export function registerArticleHandlers(register, { win, articles, workbench, translateSuiteText, getSuite, isClosing, trackOpenedLink }) {
  const articleUrl = value => {
    if (typeof value !== 'string' || value.length > 4096 || isSensitive([value])) throw new Error('请输入无敏感凭据的 HTTP(S) 网页网址。');
    return value;
  };
  function articleStore() {
    if (isClosing()) throw new Error('工作台正在退出，文章收集箱已停止接收请求。');
    if (!articles) throw new Error('文章收集箱的本地索引暂不可用。');
    return articles;
  }
  function articleDto(article) {
    if (!article) return null;
    const safe = { ...article };
    for (const key of ['rawPath', 'markdownPath', 'htmlPath', 'coverPath', 'iconPath', 'faviconPath']) delete safe[key];
    if (article.coverUrl || article.coverPath) safe.coverUrl = '/api/articles/' + article.id + '/cover';
    if (article.iconUrl || article.iconPath || article.faviconPath || article.faviconUrl) safe.iconUrl = '/api/articles/' + article.id + '/icon';
    delete safe.faviconUrl;
    return safe;
  }
  async function captureArticle(value) {
    const result = await articleStore().capture(articleUrl(value));
    if (!win.isDestroyed()) sendEvent(win.webContents, 'articles:changed', { articleId: result.article.id });
    return articleDto(result.article);
  }
  register('articles:capture-clipboard', input => {
    const suite = getSuite();
    if (!suite) throw new Error('剪贴板尚未就绪。');
    return suite.collectFromHistory(input?.id);
  });
  register('articles:list', async input => (await articleStore().list(input ?? {})).map(articleDto));
  register('articles:get', async input => articleDto(await articleStore().get(input?.id)));
  register('articles:capture', input => captureArticle(input?.url));
  register('articles:update', async input => {
    const store = articleStore();
    if (input?.status !== undefined) await store.transition(input?.id, input.status);
    if (input?.tags !== undefined) await store.setTags(input?.id, input.tags);
    return articleDto(await store.get(input?.id));
  });
  register('articles:highlight', async input => {
    const store = articleStore();
    const article = await store.get(input?.id);
    if (!article) throw new Error('文章已不存在。');
    const annotation = await store.addHighlight(article.id, input);
    const saved = annotation.annotation ?? annotation;
    const note = [article.title, article.url, saved.quote, saved.note].filter(Boolean).join('\n');
    try { await workbench.appendClipboardNote(note, 'articles'); }
    catch (error) { return { ...saved, noteError: error.message || '工作台笔记追加失败。' }; }
    return saved;
  });
  register('articles:open-link', async input => {
    const url = checkExternalLink(articleUrl(input?.url));
    if (trackOpenedLink) trackOpenedLink(url);
    else await shell.openExternal(url);
  });
  register('articles:delete', async input => articleStore().delete(input?.id));
  register('articles:annotation-remove', input => articleStore().removeAnnotation(input?.id, input?.annotationId));
  register('articles:translate', input => translateSuiteText(input?.text));
  register('articles:export', async input => {
    const store = articleStore();
    const article = await store.get(input?.id);
    if (!article) throw new Error('文章已不存在。');
    const filename = article.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/, '').slice(0, 88) || '文章';
    const result = await dialog.showSaveDialog(win, { title: '导出文章及笔记', defaultPath: filename + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return null;
    const markdownText = await store.exportMarkdown(article.id);
    await writeFile(result.filePath, markdownText, 'utf8');
    return { path: result.filePath };
  });
  return { captureArticle };
}
