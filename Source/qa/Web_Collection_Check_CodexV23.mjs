import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Exercise webpage collection in the isolated Electron fixture profile. */
export async function runWebCollectionCheck(win, { browser, workbench, fixtureRoot }) {
  assert.ok(browser?.view?.webContents, '应创建独立网页视图。');
  const marker = 'V23-Web-Collection-' + randomUUID();
  const server = createServer((request, response) => {
    const page = request.url.startsWith('/second')
      ? { title: marker + ' Second Page', text: marker + ' second page' }
      : { title: marker + ' First Page', text: marker + ' first page' };
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><title>${page.title}</title></head><body><p>${page.text}</p></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const firstUrl = `http://127.0.0.1:${address.port}/no-extract/${marker}`;
  const secondUrl = `http://127.0.0.1:${address.port}/second/${marker}`;
  const run = expression => win.webContents.executeJavaScript(expression);
  const readPage = expression => browser.view.webContents.executeJavaScript(expression);
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';

  async function until(expression, label, { read = run, timeout = 12_000 } = {}) {
    const deadline = Date.now() + timeout;
    do {
      const result = await read(expression).catch(() => false);
      if (result) return result;
      await delay(80);
    } while (Date.now() < deadline);
    throw new Error(`网页收藏验收超时：${label}`);
  }

  async function click(selector) {
    await until('Boolean(' + query(selector) + ')', '查找 ' + selector);
    await run(query(selector) + '.click()');
  }

  async function fill(selector, value) {
    const script = `(() => { const field = ${query(selector)}; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`;
    await run(script);
  }

  async function enterAddress(url) {
    await fill('#wb-links [data-wc-url]', url);
    await run(`(() => { const field = ${query('#wb-links [data-wc-url]')}; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  }

  async function clickEntry(label) {
    const entries = query('#wb-links .web-collection__list');
    await until(`Boolean([...${entries}.querySelectorAll('.web-collection__entry strong')].find(item => item.textContent.includes(${JSON.stringify(label)})))`, '查找链接 ' + label);
    await run(`(() => { const label = [...${entries}.querySelectorAll('.web-collection__entry strong')].find(item => item.textContent.includes(${JSON.stringify(label)})); label.closest('button').click(); })()`);
  }

  async function clickVisible(selector) {
    const point = await until(`(() => {
      const field = ${query(selector)};
      if (!field?.getClientRects().length) return null;
      field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = field.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!field.contains(document.elementFromPoint(x, y))) return null;
      return { x, y };
    })()`, `控件可见可点 ${selector}`, { timeout: 3_000 });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }

  const notes = '[data-wc-notes] .note-workspace:not([hidden])';
  const noteBody = `${notes} [data-nw-body]`;
  const noteSave = `${notes} [data-nw-save]`;
  const noteDialog = `${notes} [data-nw-metadata]`;

  async function noteGeometry(width, height) {
    win.setSize(width, height);
    await until(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`, `窗口调整到 ${width}×${height}`);
    const geometry = await run(`(() => {
      const panel = document.querySelector('.web-collection__notes').getBoundingClientRect();
      const workspace = ${query(notes)}.getBoundingClientRect();
      const body = ${query(noteBody)}.getBoundingClientRect();
      const save = ${query(noteSave)}.getBoundingClientRect();
      const main = document.getElementById('wb-main');
      return { pane: panel.width, workspaceHeight: workspace.height, paneHeight: panel.height,
        bodyWidth: body.width, bodyHeight: body.height, saveFits: save.right <= panel.right && save.left >= panel.left,
        horizontalOverflow: main.scrollWidth > main.clientWidth + 1 };
    })()`);
    assert.ok(geometry.bodyWidth >= 400 && geometry.bodyWidth >= geometry.pane * 0.85,
      `正文需要占据笔记卡片的主要宽度 ${width}×${height} ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bodyHeight >= 260 && geometry.workspaceHeight >= geometry.paneHeight - 3,
      `正文需要使用卡片的可用高度 ${width}×${height} ${JSON.stringify(geometry)}`);
    assert.ok(geometry.saveFits && !geometry.horizontalOverflow, JSON.stringify(geometry));
    return geometry;
  }

  try {
    await click('[data-wb-nav="links"]');
    await until('!' + query('#wb-links') + '.hidden && Boolean(' + query('#wb-links [data-wc-url]') + ')', '打开网页收藏');

    await enterAddress(firstUrl);
    await until(`location.href === ${JSON.stringify(firstUrl)}`, '回车打开未收录页面', { read: readPage });
    assert.equal(await browser.view.webContents.executeJavaScript('document.body.innerText'), marker + ' first page');
    assert.equal(await browser.view.webContents.executeJavaScript('typeof window.stilltimeDesktop'), 'undefined', '网页不应获得工作台 preload API。');
    assert.equal((await workbench.listLinks('')).some(item => item.url.includes(marker)), false, '回车浏览不应创建收藏。');

    await fill('#wb-links [data-wc-title]', marker + ' First Page');
    await click('#wb-links [data-wc-open]');
    await until(`window.stilltimeDesktop.workbench.listLinks('').then(items => items.filter(item => item.url.includes(${JSON.stringify(marker)})).length === 1)`, '保存并打开网址');
    await until(`document.body.innerText.includes(${JSON.stringify(marker + ' first page')})`, '确认内嵌页面仍可读', { read: readPage });
    await until(`!${query('#wb-links [data-wc-open]')}.disabled`, '保存操作结束');

    const duplicateUrl = firstUrl + '#duplicate';
    await fill('#wb-links [data-wc-url]', duplicateUrl);
    await click('#wb-links [data-wc-open]');
    await until(`${query('#wb-links [data-wc-message]')}.textContent.includes('已打开原收藏')`, '同网址显示重复提示');
    await until(`!${query('#wb-links [data-wc-open]')}.disabled`, '重复收录操作结束');
    assert.equal((await workbench.listLinks('')).filter(item => item.url.includes(marker)).length, 1, '重复收藏不得新增记录。');

    await enterAddress(secondUrl);
    await until(`location.pathname === ${JSON.stringify('/second/' + marker)}`, '地址栏回车直接浏览第二页', { read: readPage });
    assert.equal((await workbench.listLinks('')).filter(item => item.url.includes(marker)).length, 1, '直接浏览第二页仍不得创建记录。');
    await click('#wb-links [data-wc-back]');
    await until(`location.pathname === ${JSON.stringify('/no-extract/' + marker)}`, '浏览器后退', { read: readPage });

    await clickEntry(marker + ' First Page');
    await until(`Boolean(${query(noteBody)})`, '链接笔记编辑器已挂载');
    await click(`${notes} [data-nw-mode="source"]`);
    const originalSize = win.getSize();
    const desktopNote = await noteGeometry(1320, 890);
    const noteText = '# 页面阅读记录\n\n' + '这一行来自收藏的正文编辑器。\n'.repeat(38) + '最后一行';
    await until('', '桌面宽度下并排显示内嵌网页', { read: () => Promise.resolve(browser.view.getVisible()) });
    await fill(noteBody, noteText);
    await clickVisible(noteSave);
    await until(`${query(noteDialog)}.open`, '桌面宽度下的保存对话框');
    await until('', '对话框覆盖内嵌网页', { read: () => Promise.resolve(!browser.view.getVisible()) });
    await clickVisible(`${noteDialog} [data-nw-cancel]`);
    await until(`!${query(noteDialog)}.open && ${query(noteBody)}.value === ${JSON.stringify(noteText)}`, '取消保存保留正文');
    const narrowNote = await noteGeometry(720, 620);
    await clickVisible(noteBody);
    await until(`document.activeElement === ${query(noteBody)}`, '窄窗正文可以获得焦点');
    await clickVisible(noteSave);
    await until(`${query(noteDialog)}.open`, '窄窗保存笔记对话框');
    await until('', '保存对话框打开时隐藏原生网页', { read: () => Promise.resolve(!browser.view.getVisible()) });
    await clickVisible(`${noteDialog} [type=submit]`);
    await until(`!${query(noteDialog)}.open`, '保存并关闭笔记对话框');
    const savedLink = (await workbench.listLinks('')).find(item => item.url === firstUrl);
    const { files: savedNotes } = await workbench.listLinkNotes(savedLink.id);
    assert.equal(savedNotes.length, 1);
    assert.equal((await workbench.getLinkNote(savedLink.id, savedNotes[0].name)).body.trim(), noteText.trim());

    await click(`${notes} [data-nw-tabs] .note-workspace__tab:has([aria-selected="true"]) .note-workspace__tab-close`);
    await clickVisible(`${notes} [data-nw-list-toggle]`);
    await until(`${query(`${notes} [data-nw-list-toggle]`)}.getAttribute('aria-expanded') === 'true'`, '展开链接笔记列表');
    await clickVisible(`${notes} [data-nw-list] .note-workspace__archive-open`);
    await until(`${query(noteBody)}.value.trim() === ${JSON.stringify(noteText.trim())}`, '从笔记列表重开完整正文');
    await click(`${notes} [data-nw-mode="reading"]`);
    await until(`${query(`${notes} [data-nw-content]`)}.dataset.mode === 'reading' && ${query(`${notes} [data-nw-preview] h1`)}?.textContent === '页面阅读记录'`, '阅读模式渲染 Markdown 标题');
    const readingGeometry = await run(`(() => {
      const workspace = ${query(notes)}.getBoundingClientRect();
      const content = ${query(`${notes} [data-nw-content]`)}.getBoundingClientRect();
      const preview = ${query(`${notes} [data-nw-preview]`)}.getBoundingClientRect();
      const bodyLabel = ${query(`${notes} [data-nw-body]`)}.closest('label');
      const main = document.getElementById('wb-main');
      return { sourceHidden: bodyLabel.hidden,
        fillsContent: Math.abs(preview.width - content.width) <= 2 && Math.abs(preview.height - content.height) <= 2,
        insideCard: preview.left >= workspace.left && preview.right <= workspace.right && preview.bottom <= workspace.bottom,
        horizontalOverflow: main.scrollWidth > main.clientWidth + 1 };
    })()`);
    assert.ok(readingGeometry.sourceHidden && readingGeometry.fillsContent && readingGeometry.insideCard && !readingGeometry.horizontalOverflow,
      `阅读内容应填满笔记卡片且不溢出：${JSON.stringify(readingGeometry)}`);
    await click(`${notes} [data-nw-mode="preview"]`);
    await until(`${query(`${notes} [data-nw-content]`)}.dataset.mode === 'preview'`, '切换 Markdown 实时预览');
    const previewText = noteText + '\n\n新增 **实时预览** 验收。';
    await fill(noteBody, previewText);
    await until(`${query(`${notes} [data-nw-preview] strong`)}?.textContent === '实时预览'`, '输入 Markdown 后实时渲染粗体');
    await fill(noteBody, noteText);
    await until(`${query(`${notes} [data-nw-preview] h1`)}?.textContent === '页面阅读记录' && !${query(`${notes} [data-nw-preview] strong`)}`, '恢复原文并确认预览同步');
    await clickVisible(noteSave);
    await until(`${query(noteDialog)}.open`, '保存恢复后的笔记原文');
    await clickVisible(`${noteDialog} [type=submit]`);
    await until(`!${query(noteDialog)}.open && ${query(noteBody)}.value === ${JSON.stringify(noteText)}`, '原文保存完成');
    await click(`${notes} [data-nw-mode="source"]`);
    await until(`${query(`${notes} [data-nw-content]`)}.dataset.mode === 'source' && !${query(`${notes} [data-nw-body]`)}.closest('label').hidden`, '切回源码编辑模式');
    await noteGeometry(720, 620);
    if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'Collection_Notes_720_CodexV23.png'), (await win.capturePage()).toPNG());
    win.setSize(...originalSize);
    await run('document.getElementById("wb-main").scrollTop = 0');
    if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'Collection_Notes_1320_CodexV23.png'), (await win.capturePage()).toPNG());

    await fill('#wb-links [data-wc-title]', marker + ' Unsaved Draft');
    await click('[data-wc-refresh]');
    await until(`${query('#wb-links [data-wc-title]')}.value === ${JSON.stringify(marker + ' Unsaved Draft')}`, '刷新后保留元数据草稿');
    await click('#wb-links [data-wc-save]');
    await until(`window.stilltimeDesktop.workbench.listLinks('').then(items => items.find(item => item.url.includes(${JSON.stringify(marker)}))?.title === ${JSON.stringify(marker + ' Unsaved Draft')})`, '保存元数据草稿');
    await clickEntry(marker + ' Unsaved Draft');
    await click('#wb-links [data-wc-archive]');
    await until(`window.stilltimeDesktop.workbench.listLinks('').then(items => items.some(item => item.url.includes(${JSON.stringify(marker)}) && item.archived === true))`, '归档收藏');
    await click('#wb-links .web-collection__sections button:nth-child(4)');
    await until(`document.querySelectorAll('#wb-links .web-collection__entry').length === 1`, '归档区显示收藏');
    await fill('#wb-links [data-wc-search]', marker + ' Unsaved');
    await until(`document.querySelectorAll('#wb-links .web-collection__entry').length === 1`, '目录按标题搜索');

    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const failedPort = portProbe.address().port;
    await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    await enterAddress(`http://127.0.0.1:${failedPort}/unavailable`);
    await until(`${query('#wb-links [data-wc-error]')}.textContent.length > 0`, '显示网页加载失败反馈');
    assert.equal(browser.view.getVisible(), false, '网页失败后应收起网页视图。');

    await click('[data-wb-nav="home"]');
    await until('document.getElementById("wb-links").hidden', '离开网页收藏页');
    const hiddenDeadline = Date.now() + 3_000;
    while (browser.view.getVisible() && Date.now() < hiddenDeadline) await delay(40);
    assert.equal(browser.view.getVisible(), false, '切页后应收起网页视图。');

    return {
      addressEnterDidNotSave: true,
      saveAndOpenWithoutExtraction: true,
      duplicateCanonicalUrlKeptOneRecord: true,
      linkedNoteSavedAndReopened: true,
      linkedNoteGeometry: { desktop: desktopNote, narrow: narrowNote },
      embeddedPageHasNoWorkbenchApi: true,
      backNavigation: true,
      metadataDraftSurvivesRefresh: true,
      archiveAndSearch: true,
      failedPageFeedbackAndHiddenView: true,
      viewHiddenOnPageSwitch: true,
    };
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
}
