import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const ARTICLE_FIXTURE_URLS = Object.freeze([
  'https://reversewear-qa.invalid/sample-one',
  'https://reversewear-qa.invalid/sample-two',
]);

const longParagraph = (topic, marker, extraMarker = '') => {
  const sentences = [
    `${marker} This isolated reading fixture explores ${topic} through a careful sequence of observations and practical decisions.`,
    extraMarker ? `${extraMarker} This second selected passage verifies that a note entered in the native dialog stays attached to its source quote.` : '',
    `The first section explains why the subject matters, how the surrounding conditions shape the result, and which details a reader should record before drawing a conclusion.`,
    `A useful account separates direct observations from interpretation, preserves the order of events, and gives enough context for another person to understand the original situation.`,
    `When evidence is incomplete, the writer should identify the remaining uncertainty, describe a reasonable next step, and avoid presenting an untested assumption as a settled fact.`,
    `This paragraph is intentionally substantial so the same deterministic page can exercise the readability extraction path without depending on a public website or a live network response.`,
  ];
  return `<p>${sentences.join(' ')}</p>`;
};

function fixture(title, marker, topic, noteMarker = '') {
  const paragraphs = Array.from({ length: 5 }, (_, index) => longParagraph(`${topic}, section ${index + 1}`,
    index === 0 ? marker : `${topic.toUpperCase().replace(/\W+/g, '_')}_SECTION_${index + 1}`,
    index === 0 ? noteMarker : ''));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="Deterministic V18 article inbox verification fixture."><meta property="og:site_name" content="ReverseWear QA Journal"></head><body><header><nav>Home · Archive · Subscribe</nav></header><main><article><h1>${title}</h1><p class="byline">By V18 QA Editorial Desk</p>${paragraphs.join('\n')}<p>今天我们讨论具身机器人与控制理论的关系。</p><p><a href="https://example.org/reference">Reference link</a></p></article></main><aside>Advertisement and unrelated navigation text should not become the article body.</aside><script>window.__unsafeFixtureScriptExecuted = true;</script></body></html>`;
}

export const ARTICLE_FIXTURE_HTML = new Map([
  [ARTICLE_FIXTURE_URLS[0], fixture('V18 Article Inbox Sample One', 'V18_QA_SELECT_QUOTE_ONE', 'focused reading workflow', 'V18_QA_NOTE_QUOTE_ONE')],
  [ARTICLE_FIXTURE_URLS[1], fixture('V18 Article Inbox Sample Two', 'V18_QA_SELECT_QUOTE_TWO', 'offline research notes')],
]);

const SELECTED_QUOTE = 'V18_QA_SELECT_QUOTE_ONE';
const NOTE_QUOTE = 'V18_QA_NOTE_QUOTE_ONE';
const NOTE_TEXT = 'V18 native note dialog persistence check';

function js(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

const selector = value => `document.querySelector(${JSON.stringify(value)})`;

async function until(win, predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await js(win, "Boolean(" + predicate + ")")) return;
    await delay(60);
  }
  throw new Error(`文章收件箱桌面验收等待超时：${label}`);
}

async function findArticle(articles, url) {
  if (typeof articles.findByUrl === 'function') return articles.findByUrl(url);
  const rows = await articles.list({ status: 'all', limit: 200 });
  return rows.find(item => item.url === url || item.canonicalUrl === url) || null;
}

async function getArticle(articles, id) {
  return articles.get(id);
}

async function clickArticle(win, id, marker) {
  const card = `#wb-articles .article-inbox__card[data-id="${id}"]`;
  await js(win, `${selector(card)}?.click()`);
  await until(win, `${selector('#wb-articles .article-inbox__article')}?.textContent.includes(${JSON.stringify(marker)})`, '打开文章正文');
}

async function selectAndHighlight(win, articleId, articles, workbench) {
  await clickArticle(win, articleId, SELECTED_QUOTE);
  const selected = await js(win, `(() => {
    const article=${selector('#wb-articles .article-inbox__article')};
    const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT);
    let node; while ((node=walker.nextNode())) {
      const at=node.nodeValue.indexOf(${JSON.stringify(SELECTED_QUOTE)});
      if (at < 0) continue;
      const range=document.createRange();
      range.setStart(node,at); range.setEnd(node,at+${SELECTED_QUOTE.length});
      const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      article.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window}));
      return selection.toString();
    }
    return '';
  })()`);
  assert.equal(selected, SELECTED_QUOTE, '应能在提取后的正文中选中原文。');
  await until(win, `${selector('#wb-articles [data-selection-action="highlight"]')}?.getClientRects().length > 0`, '划词工具栏');
  await js(win, `${selector('#wb-articles [data-selection-action="highlight"]')}?.click()`);
  const highlightDeadline = Date.now() + 5000;
  let savedArticle;
  while (Date.now() < highlightDeadline) {
    savedArticle = await getArticle(articles, articleId);
    if (savedArticle?.annotations?.some(item => item.quote === SELECTED_QUOTE)) break;
    await delay(60);
  }
  assert.ok(savedArticle?.annotations?.some(item => item.kind === 'highlight' && item.quote === SELECTED_QUOTE), '高亮应写入文章批注存储。');
  const noteDeadline = Date.now() + 5000;
  let noteSaved = false;
  while (Date.now() < noteDeadline) {
    const notes = await workbench.listNotes({ kind: 'note' });
    noteSaved = notes.some(item => item.body?.includes(SELECTED_QUOTE));
    if (noteSaved) break;
    await delay(80);
  }
  assert.ok(noteSaved, '高亮引用应追加到工作台文章摘录笔记。');
  await js(win, 'window.getSelection()?.removeAllRanges()');
  return { selection: true, persistedHighlight: true, workbenchNoteReadback: true };
}

async function selectAndSaveNote(win, articleId, articles, workbench) {
  await clickArticle(win, articleId, NOTE_QUOTE);
  const selected = await js(win, `(() => {
    const article=${selector('#wb-articles .article-inbox__article')};
    const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT);
    let node; while ((node=walker.nextNode())) {
      const at=node.nodeValue.indexOf(${JSON.stringify(NOTE_QUOTE)});
      if (at < 0) continue;
      const range=document.createRange();
      range.setStart(node,at); range.setEnd(node,at+${NOTE_QUOTE.length});
      const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      article.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window}));
      return selection.toString();
    }
    return '';
  })()`);
  assert.equal(selected, NOTE_QUOTE, '应能选择用于批注的第二段原文。');
  await until(win, `${selector('#wb-articles [data-selection-action="note"]')}?.getClientRects().length > 0`, '批注工具栏');
  await js(win, `${selector('#wb-articles [data-selection-action="note"]')}?.click()`);
  const noteDialog = 'dialog[data-dialog-kind="article-note"]';
  await until(win, `${selector(noteDialog)}?.querySelector('textarea[data-dialog-input]')`, '原文批注输入对话框');
  const accepted = await js(win, `(() => {
    const dialog=${selector(noteDialog)};
    const input=dialog?.querySelector('textarea[data-dialog-input]');
    if (!dialog?.open || !input) return false;
    input.value=${JSON.stringify(NOTE_TEXT)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    dialog.querySelector('[data-dialog-submit]')?.click();
    return true;
  })()`);
  assert.equal(accepted, true, '文章批注对话框应显示文本输入和提交控件。');
  await until(win, `!${selector(noteDialog)}`, '批注对话框提交');
  const annotationDeadline = Date.now() + 5000;
  let savedArticle;
  while (Date.now() < annotationDeadline) {
    savedArticle = await getArticle(articles, articleId);
    if (savedArticle?.annotations?.some(item => item.quote === NOTE_QUOTE && item.note === NOTE_TEXT)) break;
    await delay(60);
  }
  assert.ok(savedArticle?.annotations?.some(item => item.kind === 'highlight' && item.quote === NOTE_QUOTE && item.note === NOTE_TEXT), '笔记应与所选原文共同保存为文章批注。');
  const noteDeadline = Date.now() + 5000;
  let noteSaved = false;
  while (Date.now() < noteDeadline) {
    const notes = await workbench.listNotes({ kind: 'note' });
    noteSaved = notes.some(item => item.body?.includes(NOTE_QUOTE) && item.body?.includes(NOTE_TEXT));
    if (noteSaved) break;
    await delay(80);
  }
  assert.ok(noteSaved, '原文和对话框输入的批注应写入工作台笔记。');
  await js(win, 'window.getSelection()?.removeAllRanges()');
  return { nativeNoteDialog: true, noteSavedWithQuote: true };
}

async function checkStorage(articles, article, fixtureRoot) {
  assert.ok(article.contentHtml?.includes('V18_QA_SELECT_QUOTE_ONE'), '安全 HTML 正文应包含文章原文。');
  assert.ok(article.markdownBody?.replace(/\\_/g, '_').includes('V18_QA_SELECT_QUOTE_ONE'), '文章记录应包含 Markdown 正文。');
  assert.ok(article.markdownPath, '文章记录应保留 Markdown 相对路径。');
  const articleRoot = path.join(fixtureRoot, 'DesktopSuite', 'Articles');
  const rawPath = path.join(articleRoot, 'raw', `${article.id}.source.html`);
  const markdownPath = path.join(articleRoot, 'articles', article.markdownPath);
  const [raw, markdown] = await Promise.all([readFile(rawPath, 'utf8'), readFile(markdownPath, 'utf8')]);
  assert.match(raw, /<script>window\.__unsafeFixtureScriptExecuted/);
  assert.match(markdown, /^# V18 Article Inbox Sample One/m);
  assert.match(markdown.replace(/\\_/g, '_'), /V18_QA_SELECT_QUOTE_ONE/);
  assert.equal(article.markdownBody, markdown.replace(/^# .*?\r?\n\r?\n/s, '').replace(/\r?\n$/, ''));
  const exported = await articles.exportMarkdown(article.id);
  assert.match(exported, /## 阅读批注/);
  assert.match(exported, /V18_QA_SELECT_QUOTE_ONE/);
  return { rawHtmlStored: true, markdownStored: true, markdownExportIncludesHighlight: true };
}

async function pressStatusKey(win, key) {
  await js(win, `(() => {
    window.getSelection()?.removeAllRanges();
    const article=${selector('#wb-articles .article-inbox__article')};
    article.focus();
    article.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));
  })()`);
}

export async function runArticleInboxCheck(win, { articles, workbench, fixtureRoot, articleLinksOpened }) {
  assert.ok(win && articles?.capture && articles?.list && articles?.get && workbench?.listNotes && fixtureRoot,
    '文章收件箱桌面检查需要隔离工作台、文章索引和临时数据根。');
  assert.equal(ARTICLE_FIXTURE_HTML.size, 2, '测试夹具应包含两篇互不相同的文章。');

  const root = path.resolve(fixtureRoot);
  await mkdir(root, { recursive: true });
  await js(win, `document.querySelector('.wb-nav [data-wb-nav="articles"]')?.click()`);
  await until(win, `${selector('#wb-articles')} && !${selector('#wb-articles')}.hidden`, '文章收件箱页面');
  await until(win, `${selector('#wb-articles [aria-label="要保存的网页链接"]')} && ${selector('#wb-articles .article-inbox__primary')}`, '文章抓取表单');

  const captured = [];
  for (const [index, url] of ARTICLE_FIXTURE_URLS.entries()) {
    const title = index === 0 ? 'V18 Article Inbox Sample One' : 'V18 Article Inbox Sample Two';
    await js(win, `(() => {
      const input=${selector('#wb-articles [aria-label="要保存的网页链接"]')};
      input.value=${JSON.stringify(url)};
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.form.requestSubmit();
    })()`);
    await until(win, `Array.from(document.querySelectorAll('#wb-articles .article-inbox__card')).some(card=>card.textContent.includes(${JSON.stringify(title)}))`, `保存 ${url}`);
    const item = await findArticle(articles, url);
    assert.ok(item?.id, `文章应持久化：${url}`);
    captured.push(item);
  }
  assert.notEqual(captured[0].id, captured[1].id, '两份不同文章夹具应生成独立记录。');
  assert.equal((await articles.list({ status: 'inbox', limit: 200 })).filter(item => captured.some(row => row.id === item.id)).length, 2, '两篇文章初始应处于收件箱状态。');

  const highlightEvidence = await selectAndHighlight(win, captured[0].id, articles, workbench);
  const noteEvidence = await selectAndSaveNote(win, captured[0].id, articles, workbench);
  const storageEvidence = await checkStorage(articles, await getArticle(articles, captured[0].id), root);
  assert.equal((await articles.list({ status: 'all', query: '机器人' })).length, 2);
  assert.equal((await articles.list({ status: 'all', query: '控制' })).length, 2);

  await clickArticle(win, captured[0].id, 'V18_QA_SELECT_QUOTE_ONE');
  await pressStatusKey(win, 'l');
  const laterDeadline = Date.now() + 5000;
  while (Date.now() < laterDeadline && (await getArticle(articles, captured[0].id))?.status !== 'later') await delay(60);
  assert.equal((await getArticle(articles, captured[0].id)).status, 'later');

  await clickArticle(win, captured[1].id, 'V18_QA_SELECT_QUOTE_TWO');
  await pressStatusKey(win, 'e');
  const archiveDeadline = Date.now() + 5000;
  while (Date.now() < archiveDeadline && (await getArticle(articles, captured[1].id))?.status !== 'archive') await delay(60);
  assert.equal((await getArticle(articles, captured[1].id)).status, 'archive');

  const laterButton = '#wb-articles .article-inbox__status-nav button[data-status="later"]';
  assert.equal(await js(win, `Boolean(${selector(laterButton)})`), true, '应存在稍后读状态按钮。');
  await js(win, `${selector(laterButton)}.click()`);
  try {
    await until(win, `${selector(`#wb-articles .article-inbox__card[data-id="${captured[0].id}"]`)}`, '稍后读筛选');
  } catch (error) {
    const diagnostic = await js(win, `(async () => ({
      state: document.querySelector('#wb-articles .article-inbox__status-nav [aria-current="true"]')?.dataset.status,
      rows: Array.from(document.querySelectorAll('#wb-articles .article-inbox__card'), card => card.dataset.id),
      hidden: document.querySelector('#wb-articles').hidden,
      query: document.querySelector('#wb-articles input[type="search"]').value,
      apiRows: (await window.stilltimeDesktop.articles.list({status:'later'})).map(item => item.id),
    }))()`);
    error.message += ' / ' + JSON.stringify(diagnostic);
    throw error;
  }
  assert.equal(await js(win, `document.querySelectorAll('#wb-articles .article-inbox__card').length`), 1);
  await js(win, `${selector('#wb-articles [data-status="archive"]')}?.click()`);
  await until(win, `${selector(`#wb-articles .article-inbox__card[data-id="${captured[1].id}"]`)}`, '归档筛选');
  assert.equal(await js(win, `document.querySelectorAll('#wb-articles .article-inbox__card').length`), 1);
  await js(win, `${selector('#wb-articles [data-status="inbox"]')}?.click()`);
  await until(win, `${selector('#wb-articles .article-inbox__empty')}`, '收件箱空状态');

  await js(win, selector(laterButton) + '?.click()');
  const link = selector('#wb-articles .article-inbox__article a[href="https://example.org/reference"]');
  await until(win, link, '正文链接');
  await js(win, link + '.click()');
  assert.deepEqual(articleLinksOpened, [], '脚本合成 click 不应调用浏览器入口。');
  const point = await js(win, `(() => {
    const link = ${link};
    link.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = link.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  const linkDeadline = Date.now() + 5000;
  while (!articleLinksOpened.length && Date.now() < linkDeadline) await delay(50);
  assert.deepEqual(articleLinksOpened, ['https://example.org/reference'], '真实点击应向浏览器出口提交本文链接。');

  const annotation = (await articles.get(captured[0].id)).annotations.find(item => item.quote === SELECTED_QUOTE);
  await js(win, `(() => {
    const panel = ${selector('#wb-articles .article-inbox__annotations')};
    panel.open = true;
    panel.querySelector(${JSON.stringify('[data-annotation-remove="' + annotation.id + '"]')})?.click();
  })()`);
  const removeDeadline = Date.now() + 5000;
  while ((await articles.get(captured[0].id)).annotations.some(item => item.id === annotation.id) && Date.now() < removeDeadline) await delay(50);
  assert.equal((await articles.get(captured[0].id)).annotations.length, 1, '只移除选中的批注。');
  assert.match(await articles.exportMarkdown(captured[0].id), /V18 native note dialog persistence check/);

  const captures = await Promise.all(captured.map(async ({ id }) => {
    const item = await getArticle(articles, id);
    return { id, title: item.title, status: item.status };
  }));
  const removeArticle = selector('#wb-articles [data-article-delete]');
  const deleteDialog = selector('dialog[data-dialog-kind="article-delete"]');
  await js(win, removeArticle + '?.click()');
  await until(win, deleteDialog + '?.open', '文章删除确认');
  await js(win, deleteDialog + '.querySelector("[data-dialog-cancel]").click()');
  await until(win, '!' + deleteDialog, '取消删除');
  assert.ok(await articles.get(captured[0].id));
  await js(win, removeArticle + '?.click()');
  await until(win, deleteDialog + '?.open', '再次确认删除');
  await js(win, deleteDialog + '.querySelector("[data-dialog-submit]").click()');
  await until(win, selector('#wb-articles .article-inbox__empty'), '删除后刷新列表');
  assert.equal(await articles.get(captured[0].id), null);
  await assert.rejects(readFile(path.join(root, 'DesktopSuite', 'Articles', 'raw', captured[0].id + '.source.html')), { code: 'ENOENT' });
  assert.ok((await workbench.listNotes({ kind: 'note' })).some(item => item.body?.includes(NOTE_TEXT)), '工作台笔记应独立保留。');

  const evidence = {
    verifiedAt: new Date().toISOString(),
    fixtures: ARTICLE_FIXTURE_URLS.map(url => ({ url, injected: ARTICLE_FIXTURE_HTML.has(url) })),
    captures,
    revision: { chineseTermSearch: true, articleLinkDispatch: true, syntheticClickRejected: true,
      annotationRemoval: true, articleDeletion: true, deleteCancel: true, independentWorkbenchNote: true },
    inbox: { captureForm: true, articleCount: 2, threeStatuses: true, keyboardL: true, keyboardE: true },
    ...highlightEvidence,
    ...noteEvidence,
    storage: storageEvidence,
  };
  await writeFile(path.join(root, 'ArticleInboxVerification.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidence;
}

/**
 * V23 removed the standalone article inbox UI. Keep its historical storage and
 * workbench contracts covered through the isolated article store and IPC API.
 */
export async function runArticleStorageCompatibilityCheck(win, { articles, workbench, fixtureRoot }) {
  assert.ok(win?.webContents && articles?.capture && articles?.list && articles?.get &&
    articles?.addHighlight && articles?.transition && articles?.removeAnnotation &&
    articles?.exportMarkdown && workbench?.listNotes && fixtureRoot,
  '文章存储兼容检查需要隔离窗口、文章存储、工作台和临时数据根。');
  assert.equal(ARTICLE_FIXTURE_HTML.size, 2, '存储兼容夹具应包含两篇确定性文章。');

  const root = path.resolve(fixtureRoot);
  await mkdir(root, { recursive: true });
  const captured = [];
  for (const [index, url] of ARTICLE_FIXTURE_URLS.entries()) {
    const result = await articles.capture(url);
    assert.ok(result?.article?.id, `文章捕获应返回持久记录：${url}`);
    assert.equal(result.article.title, `V18 Article Inbox Sample ${index === 0 ? 'One' : 'Two'}`,
      '文章标题应从离线 HTML 夹具提取。');
    captured.push(result.article);
  }
  assert.notEqual(captured[0].id, captured[1].id, '两条不同 URL 应保存为独立文章。');

  for (const [index, article] of captured.entries()) {
    const marker = index === 0 ? SELECTED_QUOTE : 'V18_QA_SELECT_QUOTE_TWO';
    const safeHtml = await readFile(path.join(root, 'DesktopSuite', 'Articles', 'articles', `${article.id}.safe.html`), 'utf8');
    assert.ok(safeHtml.includes(marker), '净化后的正文应保留文章文本。');
    assert.doesNotMatch(safeHtml, /<script\b|<nav\b|<aside\b|__unsafeFixtureScriptExecuted/i,
      '可展示正文应剔除脚本及导航/广告区域。');
    assert.ok(article.markdownBody?.replace(/\\_/g, '_').includes(marker), '文章记录应包含 Markdown 正文。');
    assert.ok(article.markdownPath, '文章记录应保留 Markdown 相对路径。');
  }
  const rawTwo = await readFile(path.join(root, 'DesktopSuite', 'Articles', 'raw', `${captured[1].id}.source.html`), 'utf8');
  assert.match(rawTwo, /<script>window\.__unsafeFixtureScriptExecuted/,
    '第二篇文章的原始 HTML 也应完整落盘。');

  const initialInbox = await articles.list({ status: 'inbox', limit: 200 });
  const initialFixtureRows = initialInbox.filter(item => captured.some(row => row.id === item.id));
  assert.equal(initialFixtureRows.length, 2, '两篇文章初始都应能从收件箱状态筛选。');
  const titleSearch = await articles.list({ status: 'all', query: 'Sample One', limit: 200 });
  assert.deepEqual(titleSearch.map(item => item.id), [captured[0].id], '搜索应能按文章标题定位记录。');
  const bodySearch = await articles.list({ status: 'all', query: 'observations', limit: 200 });
  assert.equal(bodySearch.filter(item => captured.some(row => row.id === item.id)).length, 2,
    '搜索应能按文章正文内容定位两篇夹具。');

  // Exercise the same preload/IPC path used by the retired article selection UI:
  // adding a highlight persists an annotation and appends its citation to Workbench notes.
  const highlight = await win.webContents.executeJavaScript(
    `window.stilltimeDesktop.articles.highlight({id:${JSON.stringify(captured[0].id)},quote:${JSON.stringify(SELECTED_QUOTE)},note:${JSON.stringify(NOTE_TEXT)}})`, true);
  assert.ok(highlight?.id, '文章批注 IPC 应返回已创建的批注。');
  let annotated = await articles.get(captured[0].id);
  assert.ok(annotated.annotations.some(item => item.id === highlight.id && item.quote === SELECTED_QUOTE && item.note === NOTE_TEXT),
    '文章批注应写入历史 annotations 存储。');
  const workbenchNotes = await workbench.listNotes({ kind: 'note' });
  assert.ok(workbenchNotes.some(item => item.body?.includes(captured[0].title) &&
    item.body?.includes(captured[0].url) && item.body?.includes(SELECTED_QUOTE) && item.body?.includes(NOTE_TEXT)),
  '文章批注 IPC 应把标题、来源链接和摘录同步到工作台笔记。');
  assert.match(await articles.exportMarkdown(captured[0].id), /V18 native note dialog persistence check/,
    'Markdown 导出应包含已保存批注。');
  const storageEvidence = await checkStorage(articles, annotated, root);

  assert.equal((await articles.transition(captured[0].id, 'later'))?.status, 'later',
    '文章状态应支持转入稍后读。');
  assert.equal((await articles.transition(captured[1].id, 'archive'))?.status, 'archive',
    '文章状态应支持归档。');
  const laterRows = await articles.list({ status: 'later', limit: 200 });
  const archiveRows = await articles.list({ status: 'archive', limit: 200 });
  assert.ok(laterRows.some(item => item.id === captured[0].id));
  assert.ok(!laterRows.some(item => item.id === captured[1].id), '稍后读筛选不应包含归档文章。');
  assert.ok(archiveRows.some(item => item.id === captured[1].id));
  assert.ok(!archiveRows.some(item => item.id === captured[0].id), '归档筛选不应包含稍后读文章。');
  assert.equal((await articles.list({ status: 'inbox', limit: 200 })).filter(item => captured.some(row => row.id === item.id)).length, 0,
    '状态迁移后两篇文章都应从收件箱筛选中移除。');

  assert.equal(await articles.removeAnnotation(captured[0].id, highlight.id), true,
    '历史批注删除 API 应删除指定批注。');
  annotated = await articles.get(captured[0].id);
  assert.ok(!annotated.annotations.some(item => item.id === highlight.id), '删除后重新读取不应包含该批注。');

  const evidence = {
    verifiedAt: new Date().toISOString(),
    check: 'V23 merged article/link storage compatibility',
    fixtures: captured.map((article, index) => ({ url: article.url, title: article.title,
      status: index === 0 ? 'later' : 'archive', sourceHtmlStored: true })),
    storage: { ...storageEvidence, secondRawHtmlStored: true, sanitizedHtml: true },
    search: { title: true, body: true },
    annotations: { ipcCreate: true, workbenchNoteSync: true, markdownExport: true, remove: true },
    statusFilters: { later: true, archive: true, inboxAfterTransitions: true },
  };
  await writeFile(path.join(root, 'ArticleStorageCompatibility_V23.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('ARTICLE_STORAGE_COMPAT_V23_OK', JSON.stringify({ articles: captured.length, statuses: ['later', 'archive'] }));
  return evidence;
}
