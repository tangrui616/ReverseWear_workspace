import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';
import { samplePdf } from './Workbench_Check_CodexV7.mjs';

export async function runInteractionCheck(win, { documentsDirectory, workbench, life }) {
  const root = path.dirname(documentsDirectory);
  const run = expression => win.webContents.executeJavaScript(expression, true);
  const element = selector => `document.querySelector(${JSON.stringify(selector)})`;
  async function until(expression, description, timeout = 16000) {
    const deadline = Date.now() + timeout;
    do {
      if (await run(expression)) return;
      await delay(70);
    } while (Date.now() < deadline);
    throw new Error(`V14 验收超时（${description}）`);
  }
  const text = selector => `${element(selector)}?.textContent`;
  const valueAt = selector => `${element(selector)}?.value`;
  const click = selector => run(`${element(selector)}.click()`);
  const set = (selector, value) => run(`(() => {
    const field = ${element(selector)};
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const textIs = (selector, value) => `${text(selector)}?.includes(${JSON.stringify(value)})`;
  const valueIs = (selector, value) => `${valueAt(selector)} === ${JSON.stringify(value)}`;
  const nav = view => click(`.wb-nav [data-wb-nav="${view}"]`);
  const shortcut = (key, selector = 'body') => run(`${element(selector)}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true }))`);
  const visible = ':not([hidden])';
  async function choose(selector, content) {
    await until(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(row => row.textContent.includes(${JSON.stringify(content)}))`, content);
    await run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(row => row.textContent.includes(${JSON.stringify(content)})).click()`);
  }
  async function saveNote(form, tags = '') {
    await until(`${element(form)}?.open`, '保存信息弹窗');
    if (tags) await set(`${form} [name=tags]`, tags);
    await click(`${form} [type=submit]`);
    await until(`!${element(form)}?.open`, '保存完成');
  }

  await until(`Boolean(${element('#wb-stopwatch-start')} && ${element('.wb-global-search')})`, '应用启动');
  await click('#wb-stopwatch-start');
  await until(`${text('#wb-stopwatch-time')} !== '00:00:00'`, '正计时');
  await click('#wb-stopwatch-pause');
  await set('#wb-stopwatch-task', '阅读论文');
  await click('[data-stopwatch-cancel]');
  assert.equal(await run(text('#wb-stopwatch-status')), '有一段时间待记录');
  await click('#wb-stopwatch-start');
  assert.equal(await run(valueAt('#wb-stopwatch-task')), '阅读论文');
  await click('[data-stopwatch-form] [type=submit]');
  await until(`!${element('#wb-stopwatch-dialog')}.open`, '第一段保存');
  await click('#wb-stopwatch-start');
  await click('#wb-stopwatch-stop');
  await set('#wb-stopwatch-task', '整理笔记');
  await click('[data-stopwatch-form] [type=submit]');
  await until(`${text('#wb-stopwatch-time')} === '00:00:00'`, '停止后复位');
  const [today] = await life.list({ kind: 'experience' });
  assert.equal(today.area, '时间轴');
  assert.match(today.fields.event, /\d\d:\d\d–\d\d:\d\d 阅读论文/);
  assert.match(today.fields.event, /整理笔记/);
  const cross = { sessionId: randomUUID(), startAt: new Date(2024, 0, 14, 23, 55).toISOString(), endAt: new Date(2024, 0, 15, 0, 5).toISOString(), task: '跨日验收' };
  await life.appendTimeline(cross);
  await life.appendTimeline(cross);
  const crossDay = (await life.list({ kind: 'experience' })).find(entry => entry.happenedAt === '2024-01-15');
  assert.equal(crossDay.fields.event.match(/跨日验收/g).length, 1);
  assert.match(crossDay.fields.event, /2024-01-1[45]/);
  console.log('V14 QA stopwatch and timeline');

  const legacy = await workbench.saveNote({ kind: 'note', title: '旧归档标题', body: '旧记录正文' });
  await nav('notes');
  const notes = '#wb-notes';
  const body = `${notes} [data-nw-body]`;
  const metadata = `${notes} [data-nw-metadata]`;
  await choose(`${notes} [data-nw-list] button`, '旧归档标题');
  assert.equal(await run(valueAt(body)), legacy.body);
  await click(`${notes} [data-nw-new]`);
  await set(body, '\n## 第一份草稿甲乙丙丁戊己\n正文一');
  await click(`${notes} [data-nw-new]`);
  await set(body, '第二份草稿\n正文二');
  await choose(`${notes} [data-nw-tabs] [role=tab]`, '第一份草稿');
  assert.match(await run(valueAt(body)), /正文一/);
  await shortcut('s', body);
  await click(`${metadata} [data-nw-cancel]`);
  assert.match(await run(valueAt(body)), /正文一/);
  await shortcut('s', body);
  await saveNote(metadata, '测试，草稿');
  const firstNote = (await workbench.listNotes({ kind: 'note' })).find(item => item.body.includes('正文一'));
  assert.equal(firstNote.title, '第一份草稿甲乙丙丁戊');
  assert.deepEqual(firstNote.tags, ['测试', '草稿']);
  await nav('home');
  await nav('notes');
  await choose(`${notes} [data-nw-tabs] [role=tab]`, '第二份草稿');
  assert.equal(await run(valueAt(body)), '第二份草稿\n正文二');
  await click(`${notes} [data-nw-save]`);
  await saveNote(metadata);

  const { item: link } = await workbench.saveLink({ title: '链接验收', url: 'https://example.com/v14-fixture' });
  await nav('links');
  await choose('#wb-links .web-collection__entry', '链接验收');
  const linkBody = '#wb-links [data-nw-body]';
  const linkMeta = '#wb-links [data-nw-metadata]';
  await until(`Boolean(document.querySelector(${JSON.stringify(linkBody)})) && document.querySelector('#wb-links [data-nw-list-toggle]')`, '收藏打开关联笔记工作区');
  await set(linkBody, '链接正文验收\n应用内保存');
  await shortcut('s', linkBody);
  await saveNote(linkMeta, '阅读');
  const linkWorkspace = await workbench.listLinkNotes(link.id);
  assert.equal(linkWorkspace.files.length, 1);
  const [linked] = linkWorkspace.files;
  const linkedPath = path.join(linkWorkspace.folder, linked.name);
  const externalText = (await readFile(linkedPath, 'utf8')).replace('应用内保存', '外部修改');
  await writeFile(linkedPath, externalText, 'utf8');
  await set(linkBody, '链接正文验收\n应用内草稿');
  await shortcut('s', linkBody);
  await click(`${linkMeta} [type=submit]`);
  await until(textIs(`${linkMeta} [data-nw-metadata-message]`, '修改'), '链接笔记外部冲突');
  assert.equal(await readFile(linkedPath, 'utf8'), externalText);
  assert.match(await run(valueAt(linkBody)), /应用内草稿/);
  const linkedConflict = '#wb-links [data-nw-conflict-dialog]';
  await until(`${element(linkedConflict)}?.open`, '查看链接笔记的磁盘版本');
  await click(`${linkedConflict} [data-nw-conflict-dialog-close]`);
  await until("!document.querySelector('#wb-links dialog[open]')", '关闭链接笔记冲突对话框');
  console.log('V14 QA note workspace and link conflict');

  const fixtures = ['阅读甲.pdf', '阅读乙.pdf'].map(name => path.join(root, name));
  await Promise.all(fixtures.map(file => writeFile(file, samplePdf())));
  const { items } = await workbench.importFiles(fixtures);
  const activePdf = `.wb-pdf-reader-tab${visible}`;
  const page = `${activePdf} .workbench-pdf__page-input`;
  const zoom = `${activePdf} .workbench-pdf__zoom-value`;
  const pdfBody = `${activePdf} [data-nw-body]`;
  const pdfMeta = `${activePdf} [data-nw-metadata]`;
  await nav('files');
  await choose('[data-file-list] .wb-entry-title', '阅读甲.pdf');
  await until(textIs(`${activePdf} .workbench-pdf__viewport`, 'first page'), 'PDF 第一页');
  await click(`${activePdf} .workbench-pdf__next`);
  await until(`${valueAt(page)} === '2' && ${textIs(`${activePdf} [data-page-number="2"] .workbench-pdf__text-layer`, 'second page')}`, 'PDF 第二页');
  await click(`${activePdf} .workbench-pdf__zoom-in`);
  await until(`${text(zoom)}?.includes('%')`, 'PDF 放大');
  const firstZoom = await run(text(zoom));
  await until(textIs(`${activePdf} [data-page-number="2"] .workbench-pdf__text-layer`, 'Acoustic'), '缩放后的第 2 页文本层');
  await set(pdfBody, 'PDF第二页笔记\n保留未保存草稿');
  const selectionEvidence = await run(`(() => {
    const range = document.createRange();
    const span = ${element(`${activePdf} [data-page-number="2"] .workbench-pdf__text-layer span`)};
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, 'Acoustic'.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const translate = ${element(`${activePdf} [data-pdf-translate]`)};
    const evidence = { selected: window.getSelection().toString(), disabled: translate.disabled,
      page: ${element(page)}.value, text: span.textContent };
    if (!translate.disabled) translate.click();
    return evidence;
  })()`);
  assert.equal(selectionEvidence.selected, 'Acoustic', JSON.stringify(selectionEvidence));
  assert.equal(selectionEvidence.disabled, false, JSON.stringify(selectionEvidence));
  try { await until(textIs(`${activePdf} [data-inline-source]`, 'Acoustic'), 'PDF 翻译原文', 8000); }
  catch (error) {
    const status = await run(text(`${activePdf} .workbench-pdf__status`));
    const source = await run(text(`${activePdf} [data-inline-source]`));
    throw new Error(`PDF 划词翻译未收到选区 ${JSON.stringify({ ...selectionEvidence, status, source })}`, { cause: error });
  }
  await click('[data-file-back]');
  await choose('[data-file-list] .wb-entry-title', '阅读乙.pdf');
  await until(textIs(`${activePdf} .workbench-pdf__viewport`, 'first page'), '第二份 PDF');
  assert.equal(await run(valueAt(pdfBody)), '');
  await choose('[data-file-tabs] .wb-file-tab-label', '阅读甲.pdf');
  await until(`${valueAt(page)} === '2' && ${textIs(`${activePdf} [data-page-number="2"] .workbench-pdf__text-layer`, 'second page')}`, '返回 PDF 第二页');
  assert.equal(await run(text(zoom)), firstZoom);
  assert.match(await run(valueAt(pdfBody)), /保留未保存草稿/);
  await until(textIs(`${activePdf} [data-inline-output]`, 'acoustic'), 'PDF 划词词典');
  await run(`(() => {
    const range = document.createRange();
    range.selectNodeContents(${element(`${activePdf} [data-page-number="2"] .workbench-pdf__text-layer span`)});
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  })()`);
  await click(`${activePdf} [data-pdf-translate]`);
  await until(`/\\p{Script=Han}/u.test(${text(`${activePdf} [data-inline-output] .translation-inline-result`)} ?? '')`, 'PDF 选句自动翻译', 120000);
  assert.equal(await run(`${element('#wb-translation-popup')}.open`), false);
  await shortcut('s', pdfBody);
  await until(valueIs(`${pdfMeta} [name=page]`, '2'), '阅读笔记关联页码');
  await saveNote(pdfMeta);
  const linkedPdf = items.find(file => file.name === '阅读甲.pdf');
  const savedPdfNote = (await workbench.listNotes({ kind: 'note', fileId: linkedPdf.id })).find(item => item.body.includes('PDF第二页笔记'));
  assert.equal(savedPdfNote.page, 2);
  await nav('notes');
  await choose(`${notes} [data-nw-categories] button`, '阅读笔记');
  await choose(`${notes} [data-nw-list] button`, 'PDF第二页笔记');
  assert.match(await run(valueAt(body)), /保留未保存草稿/);
  await click(`${notes} [data-nw-open-source]`);
  await until(valueIs(page, '2'), '阅读笔记回跳');
  console.log('V14 QA PDF tabs, inline lookup and reading archive');

  await nav('translation');
  await until(`${valueAt('[data-tr-model]')} === 'argos'`, '离线模型', 50000);
  for (const [input, expected] of [['voice', '声音'], ['声音', 'sound']]) {
    await set('[data-tr-source]', input);
    await shortcut('Enter', '[data-tr-source]');
    await until(textIs('[data-tr-lookup-result]', expected), `查词 ${input}`);
  }
  await set('[data-tr-source]', 'The patient read a book.');
  await click('[data-tr-translate]');
  await until(`/\\p{Script=Han}/u.test(${valueAt('[data-tr-output]')})`, '英汉句子翻译', 120000);
  await set('[data-tr-source]', '他今天读了一本书。');
  await click('[data-tr-translate]');
  await until(`/[A-Za-z]{3}/.test(${valueAt('[data-tr-output]')})`, '汉英句子翻译', 120000);
  console.log('V14 QA offline translation, bilingual words and sentences');

  const layouts = [];
  for (const [width, height] of [[1920, 1017], [1308, 884], [720, 620]]) {
    win.setSize(width, height);
    for (const theme of ['light', 'dark']) {
      if (await run(`${element('#wb-appearance-panel')}.hidden`)) await click('#wb-appearance');
      await click(`[data-mode-choice="${theme}"]`);
      await until(`document.documentElement.dataset.theme === '${theme}'`, `主题 ${theme}`);
      if (!await run(`${element('#wb-appearance-panel')}.hidden`)) await click('#wb-appearance');
      for (const view of ['home', 'notes', 'files', 'translation']) {
        await nav(view);
        if (view === 'home') {
          await run(`new Promise(resolve => {
            const target = document.querySelector('.wb-home-scene');
            target?.scrollIntoView({ block: 'center', inline: 'nearest' });
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)));
          })`);
          win.focus();
          win.webContents.focus();
        }
        const measures = await run(`(() => {
          const main = document.querySelector('#wb-main');
          return { innerWidth, innerHeight, overflow: main.scrollWidth - main.clientWidth };
        })()`);
        assert.ok(measures.overflow <= 2, `${width}×${height} ${theme} ${view} width overflow ${measures.overflow}`);
        if (view === 'home') {
          const frameBaseline = Number(await readOuroboros(win, 'window.__frames || 0')) || 0;
          try {
            await waitForOuroboros(() => readOuroboros(win,
              `window.__frames > ${frameBaseline} && window.__ouro?.S.night === ${theme === 'dark'} && Number(getComputedStyle(document.querySelector('#load')).opacity) < .06`),
            `首页重新获得焦点后渲染并同步 ${width}×${height} ${theme}`);
          } catch (error) {
            console.error(await run(`(() => {
              const target = document.querySelector('.wb-home-scene');
              const rect = target?.getBoundingClientRect();
              return { visible: document.visibilityState, focus: document.hasFocus(),
                card: rect && { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
                iframe: target?.querySelector('iframe')?.getBoundingClientRect().toJSON(),
                frame: document.querySelector('#wb-space iframe')?.src };
            })()`),
              await readOuroboros(win, `({ frames: window.__frames, night: window.__ouro?.S.night, load: document.querySelector('#load')?.textContent })`));
            throw error;
          }
        }
        await delay(320);
        if (view !== 'home') {
          await writeFile(path.join(root, `${view}_${width}x${height}_${theme}.png`), (await win.capturePage()).toPNG());
        }
        layouts.push({ width, height, theme, view, ...measures });
      }
    }
  }
  await writeFile(path.join(root, 'interaction-verification.json'), JSON.stringify({ layouts, timeline: true, documentTabs: true, linkConflict: true, pdfTabs: true, offlineBilingual: true }, null, 2));
  console.log('INTERACTION_VERIFY_OK', `${layouts.length} layout checks`);
}
