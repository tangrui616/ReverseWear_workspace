import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BrowserWindow, globalShortcut } from 'electron';
import { dragReaderScrollbar, samplePdf, sendReaderWheel } from './reader-fixture.mjs';

async function portableWait(win, expression, label, timeout = 9000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await win.webContents.executeJavaScript(expression);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`便携验收超时：${label}`);
}

async function verifyPortableReader(win, workbench, fixtureRoot, markdownId) {
  const filename = path.join(fixtureRoot, 'Portable_Continuous_Reader.pdf');
  await writeFile(filename, samplePdf(30), { flag: 'wx' });
  const pdf = (await workbench.importFiles([filename])).items[0];
  if (!pdf) throw new Error('便携验收 PDF 导入失败。');
  const active = '.wb-pdf-reader-tab:not([hidden])';
  await win.webContents.executeJavaScript("document.querySelector('[data-wb-nav=files]').click()");
  async function openEntry(name) {
    const entry = `[...document.querySelectorAll('[data-file-list] button.wb-entry-title')]
      .find(button => button.textContent === ${JSON.stringify(name)})`;
    await portableWait(win, `Boolean(${entry})`, name);
    await win.webContents.executeJavaScript(`${entry}.click()`);
  }
  const pdfView = `document.querySelector('${active} .workbench-pdf__viewport')`;
  await openEntry(path.basename(filename));
  await portableWait(win, `${pdfView}?.textContent.includes('first page')`, '首个 PDF 页面');
  const initial = await win.webContents.executeJavaScript(`(() => {
    const viewport = ${pdfView}; const rect = viewport.getBoundingClientRect();
    return { slots: viewport.querySelectorAll('[data-page-number]').length, canvases: viewport.querySelectorAll('canvas').length,
      point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
  })()`);
  if (initial.slots !== 30 || initial.canvases > 5) throw new Error('便携验收 PDF 可见页渲染数量异常。');
  await sendReaderWheel(win, initial.point, { deltaY: 1500 });
  await portableWait(win, `Number(document.querySelector('${active} .workbench-pdf__page-input')?.value) > 1`, 'PDF 连续跨页');
  const zoom = `document.querySelector('${active} .workbench-pdf__zoom-value')`;
  await sendReaderWheel(win, initial.point, { deltaY: -120, ctrl: true });
  await portableWait(win, `${zoom}?.textContent.includes('%')`, 'PDF Ctrl+滚轮缩放');
  const bar = await win.webContents.executeJavaScript(`(() => {
    const view = ${pdfView};
    const rect = view.getBoundingClientRect();
    const thickness = view.offsetHeight - view.clientHeight;
    return thickness > 0 && view.scrollWidth > view.clientWidth && rect.bottom <= innerHeight
      ? { x: Math.round(rect.left + view.clientWidth / 4), y: Math.round(rect.bottom - thickness / 2),
          distance: Math.round(view.clientWidth / 4), before: view.scrollLeft }
      : null;
  })()`);
  if (!bar) throw new Error('便携验收 PDF 横向滚动区域异常。');
  await dragReaderScrollbar(win, bar);
  await portableWait(win, `${pdfView}.scrollLeft > ${bar.before}`, '拖动 PDF 底部滚动条');
  await win.webContents.executeJavaScript("document.querySelector('[data-file-back]').click()");
  const markdown = (await workbench.listFiles()).find(item => item.id === markdownId);
  await openEntry(markdown.name);
  await portableWait(win, `document.querySelector('${active} .document-reader__content h1')?.textContent === 'Portable V17'`, '文库 Markdown 阅读');
  return { continuousPdf: true, limitedCanvases: initial.canvases, horizontalDrag: true, importedMarkdown: true };
}

/**
 * @param {{
 *   app: import('electron').App,
 *   win: import('electron').BrowserWindow,
 *   settings: object,
 *   workbench: object,
 *   fixtureRoot: string,
 *   DATA: string,
 *   documentsDirectory: string,
 *   portableLanguageCheck: boolean,
 *   portableAdjacentCheck: boolean,
 *   translator: object,
 *   dictionaries: object,
 *   suite: object,
 *   browser: object,
 *   articles: object,
 *   saveWithTags: Function,
 *   getCaptureWindow: () => import('electron').BrowserWindow | null,
 *   sendActivity: Function,
 *   OUROBOROS: string
 * }} context
 */
export async function runPortableVerification({
  app, win, settings, workbench, fixtureRoot, DATA, documentsDirectory,
  portableLanguageCheck, portableAdjacentCheck, translator, dictionaries,
  suite, browser, articles, saveWithTags, getCaptureWindow, sendActivity, OUROBOROS,
}) {
  if (process.argv.includes('--startup-timing')) {
    if (!app.isPackaged || !fixtureRoot) throw new Error('启动计时需要隔离成品窗口。');
    if (win.isVisible()) console.log('STARTUP_WINDOW_VISIBLE ' + Date.now());
    else win.once('show', () => console.log('STARTUP_WINDOW_VISIBLE ' + Date.now()));
    return;
  }
  const startup = await win.webContents.executeJavaScript(`(async () => {
    // Full stage construction and its intro are separate from the 3-second UI benchmark.
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const splash = document.querySelector('#st-splash');
      if (splash?.dataset.phase === 'wake') {
        const probe = await window.stilltimeDesktop.startupProbe();
        return {
          probe: probe.ok && Number.isInteger(probe.noteCount),
          canvas: Boolean(splash.querySelector('canvas')?.width),
          homeSuspended: !document.querySelector('#wb-space iframe'),
        };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const splash = document.querySelector('#st-splash');
    return {
      unavailable: true,
      phase: splash?.dataset.phase ?? null,
      booting: Boolean(splash?.classList.contains('booting')),
      uiReadyAtMs: document.documentElement.dataset.startupUiReadyAtMs ?? null,
      stageReadyAtMs: document.documentElement.dataset.startupStageReadyAtMs ?? null,
      config: localStorage.getItem('stilltime.startup:config'),
    };
  })()`);
  if (!startup.probe || !startup.canvas || !startup.homeSuspended) {
    throw new Error('便携版开屏检查失败：' + JSON.stringify(startup));
  }
  startup.skipButton = await win.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('st-skip');
    if (!(button instanceof HTMLButtonElement) || button.hidden || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  })()`);
  if (!startup.skipButton) throw new Error('未找到便携版开屏跳过按钮。');
  startup.skipped = await win.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (!document.querySelector('#st-splash') && !document.getElementById('workbench').inert) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`);
  if (!startup.skipped) throw new Error('便携版开屏跳过检查失败。');

  const version = await win.webContents.executeJavaScript(`(async () => {
    const until = Date.now() + 10000;
    while (!document.querySelector('.wb-global-search') && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const capture = window.stilltimeDesktop.capture;
    const ready = Boolean(window.stilltimeDesktop.search && window.stilltimeDesktop.weeklyReview &&
      capture && document.querySelector('.wb-global-search') && document.querySelector('#wb-weekly form') &&
      window.stilltimeDesktop.translation && window.stilltimeDesktop.life &&
      document.querySelector('#wb-translation form') && document.querySelector('#wb-life form'));
    if (ready) await capture.openQuickCapture();
    return { title: document.title, ready };
  })()`);
  if (!version.ready || !version.title.includes('反穿衣工作台')) throw new Error('便携版界面检查失败。');
  const captureWindow = getCaptureWindow();
  const deadline = Date.now() + 10000;
  let popupReady = false;
  while (captureWindow && !captureWindow.isDestroyed() && Date.now() < deadline) {
    popupReady = await captureWindow.webContents.executeJavaScript('Boolean(window.stilltimeCapture && document.querySelector("#capture-text"))').catch(() => false);
    if (popupReady) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!popupReady) throw new Error('便携版快速记录窗口检查失败。');
  const captureText = 'V23 便携快速记录 IPC 验收';
  await captureWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#capture-source-remove').click();
    document.querySelector('#capture-text').value = ${JSON.stringify(captureText)};
    document.querySelector('#capture-form').requestSubmit();
  })()`);
  const submitDeadline = Date.now() + 10000;
  while (!captureWindow.isDestroyed() && Date.now() < submitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const captured = await win.webContents.executeJavaScript(
    `window.stilltimeDesktop.capture.listCaptures().then(items => items.some(item => item.text === ${JSON.stringify(captureText)} && !item.source))`,
  );
  if (!captureWindow.isDestroyed() || !captured) throw new Error('便携版快速记录保存或关闭失败。');
  win.focus();
  sendActivity();
  const homeReady = await win.webContents.executeJavaScript(`(async () => {
    const end = Date.now() + 20000;
    do {
      const frame = document.querySelector('#wb-space iframe');
      if (frame?.clientWidth > 0 && frame.clientHeight > 0 &&
          document.querySelector('#wb-stopwatch-start') && window.stilltimeDesktop.life.appendTimeline) return true;
      await new Promise(resolve => setTimeout(resolve, 70));
    } while (Date.now() < end);
    return false;
  })()`);
  if (!homeReady) throw new Error('便携版首页交互检查失败。');
  let scenePlaceholder = false;
  const sceneDeadline = Date.now() + 15000;
  do {
    const renderer = win.webContents.mainFrame.framesInSubtree.find(frame =>
      frame.url.split('?')[0] === OUROBOROS + '/host.html');
    scenePlaceholder = renderer ? await renderer.executeJavaScript('Boolean(document.querySelector("#ouroboros-unavailable"))').catch(() => false) : false;
    if (scenePlaceholder) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < sceneDeadline);
  if (!scenePlaceholder) throw new Error('便携版首页衔尾蛇占位检查失败。');
  const focusReady = await win.webContents.executeJavaScript(`(async () => {
    const end = Date.now() + 10000;
    document.querySelector('.wb-focus-nav').click();
    do {
      const rotation = document.getElementById('wallpaperRotation');
      const sound = document.getElementById('wallpaperSound');
      if (!document.body.classList.contains('workbench-active') && rotation.dataset.ready === 'true' && sound.title) {
        const initial = {
          rotation: rotation.getAttribute('aria-pressed') === 'true',
          sound: sound.getAttribute('aria-pressed') === 'true',
        };
        const setPersisted = async (button, key, desired) => {
          if ((button.getAttribute('aria-pressed') === 'true') !== desired) button.click();
          while (Date.now() < end) {
            const state = await window.stilltimeDesktop.loadState();
            if ((button.getAttribute('aria-pressed') === 'true') === desired && state[key] === desired) return true;
            await new Promise(resolve => setTimeout(resolve, 70));
          }
          return false;
        };
        const changed = await setPersisted(rotation, 'wallpaperRotation', !initial.rotation) &&
          await setPersisted(sound, 'wallpaperSound', !initial.sound);
        const current = document.getElementById('currentWallpaper');
        const originalTitle = current.textContent;
        const waitForTitle = async matches => {
          while (Date.now() < end) {
            if (matches(current.textContent)) return true;
            await new Promise(resolve => setTimeout(resolve, 70));
          }
          return false;
        };
        document.getElementById('nextWallpaper').click();
        const advanced = await waitForTitle(title => title !== originalTitle);
        document.getElementById('prevWallpaper').click();
        const returned = await waitForTitle(title => title === originalTitle);
        const restored = await setPersisted(rotation, 'wallpaperRotation', initial.rotation) &&
          await setPersisted(sound, 'wallpaperSound', initial.sound);
        const state = await window.stilltimeDesktop.loadState();
        document.getElementById('backToWorkbench').click();
        return changed && restored && state.wallpaperRotation === initial.rotation &&
          state.wallpaperSound === initial.sound && advanced && returned;
      }
      await new Promise(resolve => setTimeout(resolve, 70));
    } while (Date.now() < end);
    return false;
  })()`);
  if (!focusReady) throw new Error('便携版专注计时开关或壁纸切换检查失败。');
  const markdownSource = path.join(fixtureRoot, 'Portable_V17_Reader.md');
  await writeFile(markdownSource, '# Portable V17\n\n| field | value |\n| --- | --- |\n| ready | yes |\n');
  const imported = await workbench.importFiles([markdownSource]);
  const fileId = imported.items[0]?.id;
  if (!fileId) throw new Error('便携版文档导入检查失败。');
  const documentReady = await win.webContents.executeJavaScript(`(async () => {
    const response = await fetch('/api/workbench/document-render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: ${JSON.stringify(fileId)} }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const rendered = new DOMParser().parseFromString(result.html, 'text/html');
    return rendered.querySelector('h1')?.textContent === 'Portable V17' && Boolean(rendered.querySelector('table'));
  })()`);
  if (!documentReady) throw new Error('便携版文档阅读检查失败。');
  const readerControls = await verifyPortableReader(win, workbench, fixtureRoot, fileId);
  const notesFolder = path.join(documentsDirectory, 'Notes');
  const noteName = 'V22 更新说明.md';
  const noteTitle = 'V22 便携笔记验收';
  if (!portableAdjacentCheck) {
    await mkdir(notesFolder, { recursive: true });
    await writeFile(path.join(notesFolder, noteName), '# ' + noteTitle + '\n\n普通 Markdown 正文。\n', { flag: 'wx' });
  }
  const externalNote = (await workbench.listNotes({ kind: 'note', query: noteTitle })).find(note => note.title === noteTitle);
  if (!externalNote) throw new Error('便携版普通 Markdown 发现检查失败。');
  const portableNotesReady = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-wb-nav="notes"]')?.click();
    const until = Date.now() + 7000;
    do {
      const entry = [...document.querySelectorAll('#wb-notes .note-workspace__archive-open')]
        .find(button => button.textContent.includes(${JSON.stringify(noteTitle)}));
      if (entry) {
        entry.click();
        return document.querySelector('#wb-notes [data-nw-preview] h1')?.textContent === ${JSON.stringify(noteTitle)};
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < until);
    return false;
  })()`);
  if (!portableNotesReady) throw new Error('便携版笔记入口检查失败。');
  const noteSaved = await win.webContents.executeJavaScript(`(async () => {
    const editor = document.querySelector('#wb-notes [data-nw-body]');
    editor.value += '\\n\\n目录便携版界面保存验收。';
    const expectedBody = editor.value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#wb-notes [data-nw-save]').click();
    const form = document.querySelector('#wb-notes [data-nw-metadata-form]');
    if (!form.closest('dialog').open) return false;
    form.requestSubmit();
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      if (!form.closest('dialog').open) {
        const saved = (await window.stilltimeDesktop.workbench.listNotes({ kind: 'note' }))
          .find(item => item.id === ${JSON.stringify(externalNote.id)});
        return saved?.body === expectedBody && editor.value === expectedBody;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return false;
  })()`);
  if (!noteSaved) throw new Error('目录便携版笔记编辑或保存失败。');
  const folderName = '便携目录验收';
  const folderReady = await win.webContents.executeJavaScript(`(async () => {
    const api = window.stilltimeDesktop.workbench;
    const created = await api.createFolder({scope:'notes',name:${JSON.stringify(folderName)}});
    return (await api.listFolders({scope:'notes'})).includes(created.path);
  })()`);
  if (!folderReady) throw new Error('便携版真实文件夹创建失败。');
  await saveWithTags(workbench.saveNote({ kind: 'note', title: 'Portable V17', body: 'Portable V17', tags: ['便携验收'] }), ['便携验收']);
  const tagsReady = await win.webContents.executeJavaScript("window.stilltimeDesktop.recentTags.list().then(tags => tags.includes('便携验收'))");
  if (!tagsReady) throw new Error('便携版最近标签检查失败。');
  const language = [];
  if (portableLanguageCheck) {
    const available = await translator.status();
    for (const engine of ['argos', 'opus', 'hy-mt2']) {
      const directions = available.engines.filter(item => item.id === engine && item.available);
      if (directions.length !== 2) throw new Error(`成品中 ${engine} 的双向模型未就绪。`);
      for (const { direction } of directions) {
        const text = direction === 'en-zh' ? 'The room was quiet during the recording.' : '录音期间房间很安静。';
        const result = await translator.translate({ text, direction, engine });
        if (!(direction === 'en-zh' ? /\p{Script=Han}/u : /[A-Za-z]{3}/).test(result.text)) {
          throw new Error(`成品中 ${engine} ${direction} 翻译失败。`);
        }
        language.push({ engine, direction });
      }
    }
    const lookup = await dictionaries.lookup({ text: 'voice', direction: 'en-zh' });
    if (!lookup.entries.length) throw new Error('成品本地词典检查失败。');
  }
  const suiteCheck = suite.testing;
  const nativeShortcutChecked = process.argv.includes('--verify-shortcuts');
  const historyShortcutRegistered = nativeShortcutChecked
    ? globalShortcut.isRegistered(suiteCheck.store.getSettings().shortcuts.history) : null;
  if (nativeShortcutChecked && !historyShortcutRegistered) throw new Error('便携版 Alt+V 剪贴板快捷键未注册。');
  if (!suiteCheck.nativeAvailable || !Number.isInteger((await suiteCheck.bridge.request('snapshot')).sequence))
    throw new Error('便携版 Windows 剪贴板助手未就绪。');
  const stored = await suiteCheck.store.addItem({ type: 'text', text: 'ReverseWear portable suite health check' });
  if (!suiteCheck.store.search('suite health').some(item => item.id === stored.item.id))
    throw new Error('便携版剪贴板全文索引未就绪。');
  let nativeHistoryOpened = false;
  if (nativeShortcutChecked) {
    win.focus();
    win.webContents.focus();
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$keyboard = New-Object -ComObject WScript.Shell; $keyboard.SendKeys('%v')"],
      { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve());
    });
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const popup = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() &&
        window.isVisible() && window.webContents.getURL().endsWith('/clipboard.html'));
      if (popup) {
        nativeHistoryOpened = true;
        await popup.webContents.executeJavaScript('window.desktopSuite.invoke("window.hide", {})');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (!nativeHistoryOpened) throw new Error('原生 Alt+V 未打开剪贴板浮窗。');
  }
  const drawer = await suiteCheck.openPanel('clipboard');
  const suiteReady = await drawer.win.webContents.executeJavaScript(
    'Boolean(window.desktopSuite && document.querySelector("input[type=search]") && document.querySelectorAll(".mac-window-controls button").length === 3)',
  );
  if (!suiteReady) throw new Error('便携版剪贴板浮窗未就绪。');
  await drawer.win.webContents.executeJavaScript('window.desktopSuite.invoke("window.hide", {})');
  await win.webContents.executeJavaScript("document.querySelector('[data-wb-nav=clipboard]').click()");
  await portableWait(win, `document.querySelector('[data-item-id="${stored.item.id}"] input[type=checkbox]')`, '剪贴板待删除的记录');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-item-id="${stored.item.id}"] input[type=checkbox]').click();
    document.querySelector('[data-cp-delete-selected]').click();
    document.querySelector('[data-cp-delete-dialog] button[value=delete]').click();
  })()`);
  await portableWait(win, `!document.querySelector('[data-item-id="${stored.item.id}"]')`, '剪贴板记录已删除');
  const webpage = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>ReverseWear V23 browser</title><input value="No article body">');
  }).listen(0, '127.0.0.1');
  await once(webpage, 'listening');
  let webCollectionReady = false;
  try {
    const url = 'http://127.0.0.1:' + webpage.address().port + '/fixture';
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-wb-nav="links"]').click();
      const address = document.querySelector('#wb-links [data-wc-url]');
      address.value = ${JSON.stringify(url)};
      address.dispatchEvent(new Event('input', { bubbles:true }));
      document.querySelector('#wb-links [data-wc-open]').click();
    })()`);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      webCollectionReady = browser.view.webContents.getTitle() === 'ReverseWear V23 browser' &&
        (await workbench.listLinks('')).some(item => item.url === url);
      if (webCollectionReady) break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    if (!webCollectionReady) throw new Error('便携版网页收藏或内嵌浏览器未就绪。');
    if (await browser.view.webContents.executeJavaScript('typeof window.stilltimeDesktop') !== 'undefined') {
      throw new Error('内嵌网页不应获得工作台接口。');
    }
    await portableWait(win, "document.querySelector('#wb-links [data-nw-body]:not([hidden])')", '收藏笔记编辑器');
    await win.webContents.executeJavaScript(`(() => {
      const mount = document.querySelector('#wb-links .web-collection__note-workspace:not([hidden])');
      const body = mount.querySelector('[data-nw-body]');
      body.value = '# 收藏笔记成品验收\\n\\n**正文**';
      body.dispatchEvent(new Event('input', { bubbles: true }));
      mount.querySelector('[data-nw-save]').click();
      mount.querySelector('[data-nw-metadata-form]').requestSubmit();
    })()`);
    const link = (await workbench.listLinks('')).find(item => item.url === url);
    await portableWait(win, `window.stilltimeDesktop.workbench.listLinkNotes(${JSON.stringify(link.id)}).then(result => result.files.length > 0)`, '收藏笔记已落盘');
    const linkedNote = (await workbench.listLinkNotes(link.id)).files[0];
    if (!(await workbench.getLinkNote(link.id, linkedNote.path)).body.includes('**正文**')) throw new Error('收藏笔记文件内容不一致。');
  } finally {
    browser.close();
    await new Promise(resolve => webpage.close(resolve));
  }
  await suite.close();
  articles?.close();
  await writeFile(path.join(fixtureRoot, 'portable-verification.json'), JSON.stringify({
    title: version.title, version: app.getVersion(), pid: process.pid, ready: true, capturePopupReady: true, scenePlaceholder, focusReady, documentReady, tagsReady, language, suiteReady, webCollectionReady,
    startup, portableNotesReady, noteSaved, folderReady, readerControls, clipboardDelete: true, linkedNoteSaved: true, nativeShortcutChecked, historyShortcutRegistered, nativeHistoryOpened,
    noteId: externalNote.id, dataRoot: DATA, adjacent: portableAdjacentCheck,
  }));
  app.exit(0);
}
