import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OUROBOROS } from '../main/origins.mjs';
import { waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

import { dragReaderScrollbar, samplePdf, sendReaderWheel } from './reader-fixture.mjs';
export { samplePdf } from './reader-fixture.mjs';

export async function runWorkbenchCheck(win, store) {
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root, 'Use an isolated data root');
  const inspect = source => win.webContents.executeJavaScript(source, true);
  const evidence = {};
  async function until(expression, time = 14000) {
    const end = Date.now() + time;
    do {
      const result = await inspect(expression);
      if (result) return result;
      await delay(100);
    } while (Date.now() < end);
    const status = await inspect('document.querySelector(".workbench-pdf__status")?.textContent || document.querySelector("[data-pdf-view]")?.textContent || ""');
    throw new Error('Timed out: ' + expression + ' ' + status);
  }
  const click = selector => inspect('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const nav = view => click('.wb-nav [data-wb-nav=' + view + ']');
  const textAt = selector => 'document.querySelector(' + JSON.stringify(selector) + ')?.textContent';
  const input = (selector, value) => inspect('(() => { const field = document.querySelector(' + JSON.stringify(selector) + '); field.value = ' + JSON.stringify(value) + '; field.dispatchEvent(new Event("input", {bubbles:true})); })()');
  const save = async (form, status, values) => {
    for (const [field, value] of Object.entries(values)) await input(form + ' [name=' + field + ']', value);
    await click(form + ' [type=submit]');
    await until(textAt(status) + ' === "已保存"');
  };
  const saveNote = async (workspace, body, date = '', tags = '') => {
    await input(workspace + ' [data-nw-body]', body);
    await click(workspace + ' [data-nw-save]');
    const metadata = workspace + ' [data-nw-metadata]';
    if (date) await input(metadata + ' [name=date]', date);
    if (tags) await input(metadata + ' [name=tags]', tags);
    await click(metadata + ' [type=submit]');
    await until('!document.querySelector(' + JSON.stringify(metadata) + ').open');
  };
  const screenshots = path.join(root, 'Screenshots');
  await mkdir(screenshots, { recursive: true });
  const scenePlaceholder = () => {
    const frame = win.webContents.mainFrame.framesInSubtree.find(item => item.url.split('?')[0] === OUROBOROS + '/host.html');
    return frame?.executeJavaScript('Boolean(document.querySelector("#ouroboros-unavailable"))');
  };
  await waitForOuroboros(scenePlaceholder, 'scene placeholder on Home');
  await delay(380);
  const before = await win.capturePage();
  await writeFile(path.join(screenshots, 'Stilltime_Workbench_Home_CodexV7.png'), before.toPNG());
  evidence.three = { placeholder: true };

  await nav('links');
  const sampleUrl = 'https://example.invalid/acoustics#overview';
  await input('[data-wc-url]', sampleUrl);
  assert.equal((await store.listLinks()).length, 0, 'Typing a URL only fills the address field');
  await click('[data-wc-open]');
  await until('document.querySelector(".web-collection__entry")?.textContent.includes("acoustics")');
  assert.equal((await store.listLinks()).length, 1);
  await input('[data-wc-url]', sampleUrl);
  const duplicate = await inspect(`window.stilltimeDesktop.workbench.saveLink({url:${JSON.stringify(sampleUrl)}})`);
  assert.equal(duplicate.duplicate, true);
  await input('[data-wc-title]', '声学资料');
  await input('[data-wc-tags]', '病理语音，数据集，待精读');
  await click('[data-wc-save]');
  await until('document.querySelector(".web-collection__sections")?.textContent.includes("病理语音")');
  await click('[data-wc-later]');
  await until('document.querySelector("[data-wc-later]").getAttribute("aria-pressed") === "true"');
  await inspect(`[...document.querySelectorAll('.web-collection__sections button')].find(button => button.textContent === '稍后读')?.click()`);
  await input('[data-wc-search]', '病理语音');
  await until('document.querySelector(".web-collection__list")?.textContent.includes("声学资料")');
  assert.equal((await store.listLinks()).length, 1);
  evidence.links = { requiresExplicitSave: true, duplicate: true, multiTagSearch: true, partitionSidebar: true, readLater: true };

  await nav('notes');
  await saveNote('#wb-notes', '# 研究笔记\n\n记录病理语音音频。', '2026-11-07', '实验');
  await input('#wb-notes [data-nw-search]', '病理语音');
  await until(textAt('#wb-notes [data-nw-list]') + '?.includes("研究笔记")');
  for (const title of ['日报', '周报']) {
    await inspect(`[...document.querySelectorAll('#wb-notes [data-nw-categories] button')].find(button => button.textContent === '${title}').click()`);
    await click('#wb-notes [data-nw-new]');
    await saveNote('#wb-notes', title + '验收\n确认归档。', '2026-11-07');
  }
  evidence.notes = { chineseBodySearch: true, distinctArchives: true };

  const fixtureDir = path.join(root, 'Fixtures');
  await mkdir(fixtureDir, { recursive: true });
  const fixturePdf = path.join(fixtureDir, '阅读测试.pdf');
  const fixtureData = path.join(fixtureDir, '验收文件.custom');
  await writeFile(fixturePdf, samplePdf());
  await writeFile(fixtureData, '任意扩展名');
  await nav('files');
  const dropPoint = await inspect('(() => { const rect = document.querySelector("[data-file-drop]").getBoundingClientRect(); return { x: rect.left + 75, y: rect.top + rect.height / 2 }; })()');
  const debuggerSession = win.webContents.debugger;
  debuggerSession.attach('1.3');
  try {
    const data = { items: [], files: [fixturePdf, fixtureData], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await debuggerSession.sendCommand('Input.dispatchDragEvent', { ...dropPoint, type, data });
    }
  } finally {
    debuggerSession.detach();
  }
  await until('document.querySelector("[data-file-list]")?.textContent.includes("验收文件.custom")');
  const files = await store.listFiles();
  assert.equal(files.length, 2);
  const imported = files.find(file => file.isPdf);
  assert.equal(await readFile(fixtureData, 'utf8'), await readFile(await store.getFilePath(files.find(file => !file.isPdf).id), 'utf8'));
  await click('[data-file-list] button.wb-entry-title');
  await until(textAt('.workbench-pdf__viewport') + '?.includes("first page")');
  await until('document.querySelector(".workbench-pdf__viewport").scrollHeight > document.querySelector(".workbench-pdf__viewport").clientHeight');
  assert.equal(await inspect('document.querySelectorAll(".workbench-pdf__viewport [data-page-number]").length'), 2,
    'PDF 连续阅读应建立每页独立占位');
  const wheelPoint = await inspect('(() => { const bounds = document.querySelector(".workbench-pdf__viewport").getBoundingClientRect(); return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2), height: Math.round(bounds.height) }; })()');
  await sendReaderWheel(win, wheelPoint, { deltaY: 1200 });
  try { await until('document.querySelector(".workbench-pdf__page-input").value === "2"', 4000); }
  catch (error) {
    const layout = await inspect(`(() => { const view = document.querySelector('.workbench-pdf__viewport');
      return { top: view.scrollTop, total: view.scrollHeight, height: view.clientHeight,
        hit: document.elementFromPoint(${wheelPoint.x}, ${wheelPoint.y})?.className,
        page: document.querySelector('.workbench-pdf__page-input')?.value,
        slots: [...view.querySelectorAll('[data-page-number]')].map(slot => [slot.offsetTop, slot.offsetHeight]) }; })()`);
    throw new Error(`PDF 滚动未更新页码 ${JSON.stringify(layout)}`, { cause: error });
  }
  assert.ok(await inspect('document.querySelector(".workbench-pdf__viewport").scrollTop > 0'), '普通滚轮应在 PDF 阅读区纵向滚动');
  await until("document.querySelector('[data-page-number=\"2\"] .workbench-pdf__canvas')?.width > 0");
  await sendReaderWheel(win, wheelPoint, { deltaY: -100, ctrl: true });
  await until(textAt('.workbench-pdf__zoom-value') + '?.includes("%")');
  assert.ok(await inspect('document.querySelector(".workbench-pdf__viewport").scrollTop > 0'), '缩放后应保留文档滚动位置');
  const burstPreview = await inspect(`(() => {
    const viewport = document.querySelector('.workbench-pdf__viewport');
    const point = { x: ${wheelPoint.x}, y: ${wheelPoint.y} };
    const page = document.elementFromPoint(point.x, point.y)?.closest('[data-page-number]');
    if (!page) throw new Error('滚轮位置没有 PDF 页面');
    const canvas = page.querySelector('.workbench-pdf__canvas');
    const before = page.getBoundingClientRect();
    const previousPixels = canvas?.width * canvas?.height;
    for (let index = 0; index < 5; index++) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, ctrlKey: true, clientX: point.x, clientY: point.y, cancelable: true,
      }));
    }
    return {
      canvasRetained: canvas?.isConnected === true && previousPixels > 0,
      pageNumber: page.dataset.pageNumber,
      normalized: { x: (point.x - before.left) / before.width, y: (point.y - before.top) / before.height },
      previousPixels,
    };
  })()`);
  assert.equal(burstPreview.canvasRetained, true, '缩放手势期间保留已绘制页面，避免白屏');
  await until(`(() => {
    const canvas = document.querySelector('[data-page-number="${burstPreview.pageNumber}"] .workbench-pdf__canvas');
    return canvas && canvas.width * canvas.height > ${burstPreview.previousPixels};
  })()`);
  const burstResult = await inspect(`(() => {
    const viewport = document.querySelector('.workbench-pdf__viewport');
    const page = document.querySelector('[data-page-number="' + ${burstPreview.pageNumber} + '"]');
    const canvas = page.querySelector('.workbench-pdf__canvas');
    const rect = page.getBoundingClientRect();
    const point = { x: ${wheelPoint.x}, y: ${wheelPoint.y} };
    return {
      canvasPixels: canvas?.width * canvas?.height,
      anchor: { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height },
      scroll: [viewport.scrollLeft, viewport.scrollTop],
    };
  })()`);
  assert.ok(burstResult.canvasPixels > 0, '合并后的缩放完成页面重绘');
  assert.ok(Math.abs(burstResult.anchor.x - burstPreview.normalized.x) < .025 &&
    Math.abs(burstResult.anchor.y - burstPreview.normalized.y) < .025,
    '缩放后鼠标指向的页面内容位置稳定');
  const scrollbar = await inspect(`(async () => {
    const view = document.querySelector('.workbench-pdf__viewport');
    view.scrollLeft = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = view.getBoundingClientRect();
    const thickness = view.offsetHeight - view.clientHeight;
    return thickness > 0 && view.scrollWidth > view.clientWidth && rect.bottom <= innerHeight
      ? { x: Math.round(rect.left + view.clientWidth / 5), y: Math.round(rect.bottom - thickness / 2),
          distance: Math.round(view.clientWidth / 4) }
      : null;
  })()`);
  assert.ok(scrollbar, '放大后横向滚动条位于窗口内');
  await dragReaderScrollbar(win, scrollbar);
  await until("document.querySelector('.workbench-pdf__viewport').scrollLeft > 0");
  await click('.workbench-pdf__previous');
  await until('document.querySelector(".workbench-pdf__page-input").value === "1"');
  await until(textAt('[data-page-number="1"] .workbench-pdf__text-layer') + '?.includes("first page")');
  const pixel = await inspect('(() => { const canvas = document.querySelector(".workbench-pdf__canvas"); return canvas.width > 200 && canvas.getContext("2d").getImageData(1,1,1,1).data[0] > 240; })()');
  assert.equal(pixel, true);
  await click('.workbench-pdf__next');
  await until(textAt('.workbench-pdf__viewport') + '?.includes("second page")');
  await until('document.querySelector(".workbench-pdf__page-input").value === "2"');
  const selectedText = await inspect(`(() => { const span = document.querySelector('[data-page-number="2"] .workbench-pdf__text-layer span'); const range = document.createRange(); range.selectNodeContents(span); const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range); return selected.toString(); })()`);
  assert.match(selectedText, /Acoustic dataset/);
  await until("document.querySelector('[data-pdf-translate]')?.disabled === false");
  await click('[data-pdf-translate]');
  await until(textAt('[data-pdf-translation] .translation-inline-original') + '?.includes("Acoustic dataset")');
  await saveNote('[data-pdf-notes]', '第 2 页摘录\n' + selectedText);
  await click('.workbench-pdf__previous');
  await until(textAt('.workbench-pdf__viewport') + '?.includes("first page")');
  await nav('notes');
  await inspect(`[...document.querySelectorAll('#wb-notes [data-nw-categories] button')].find(button => button.textContent === '阅读笔记').click()`);
  await until(textAt('#wb-notes [data-nw-list]') + '?.includes("第 2 页摘录")');
  await click('#wb-notes [data-nw-list] .note-workspace__archive-open');
  await click('#wb-notes [data-nw-open-source]');
  await until('document.querySelector(".workbench-pdf__page-input").value === "2" && ' + textAt('.workbench-pdf__viewport') + '?.includes("second page")');
  await writeFile(path.join(screenshots, 'Stilltime_Workbench_PDF_CodexV7.png'), (await win.capturePage()).toPNG());
  assert.equal((await store.listNotes({ kind: 'note', fileId: imported.id }))[0].page, 2);
  evidence.files = { desktopDrop: true, arbitraryExtension: true, originalPreserved: true, pdfCanvas: true, zoomPreview: true, zoomAnchor: true, horizontalDrag: true, selectableText: true, selectionToTranslation: true, notePageJump: true };
  for (const directory of ['Links', 'Notes', 'Daily', 'Weekly']) {
    const files = await readdir(path.join(root, 'Documents', directory));
    assert.ok(files.some(file => file.endsWith('.md')), directory);
  }

  await click('.wb-focus-nav');
  await click('#start');
  await until('document.querySelector("#startText").textContent === "暂停片刻"');
  await click('#backToWorkbench');
  await until(textAt('.wb-focus-clock') + '?.includes(":")');
  await click('.wb-focus-nav');
  await click('#start');
  await click('#backToWorkbench');
  evidence.timerAcrossViews = true;
  await win.webContents.reload();
  await waitForOuroboros(scenePlaceholder, 'scene placeholder on returning Home');
  await nav('notes');
  await until(textAt('#wb-notes [data-nw-list]') + '?.includes("研究笔记")');
  evidence.reopen = true;
  assert.equal(await inspect('fetch("https://example.invalid/").then(() => false, () => true)'), true);
  evidence.externalNetworkBlocked = true;
  await writeFile(path.join(root, 'Workbench_Verification_CodexV7.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('WORKBENCH_VERIFY_OK', JSON.stringify(evidence));
  win.close();
}
