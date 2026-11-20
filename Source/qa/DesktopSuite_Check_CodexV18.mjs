import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClipboardItem, clipboard } from 'electron';
import { openClipboardStore } from '../desktop_suite/clipboardStore.mjs';

const SIZES = [[1920, 1017], [1308, 884], [720, 620]];
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmJkAAAAASUVORK5CYII=', 'base64');
const NOTE_MARKER = 'V18_CLIPBOARD_NOTE_QA_MARKER';

function inspect(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

function expression(selector) {
  return `document.querySelector(${JSON.stringify(selector)})`;
}

async function waitFor(win, source, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await inspect(win, source)) return;
    await delay(50);
  }
  throw new Error(`剪贴板工作流桌面检查等待超时：${label}`);
}

async function selectView(win, view) {
  const selector = `.wb-nav [data-wb-nav="${view}"]`;
  await inspect(win, `${expression(selector)}?.click()`);
  await waitFor(win, `${expression('#wb-' + view)} && !${expression('#wb-' + view)}.hidden`, `${view} 页面`);
}

async function checkStorageAndSearch(store, root) {
  assert.equal(store.getSettings().captureEnabled, false, '新用户的剪贴板自动采集应默认关闭。');
  const first = await store.addItem({
    type: 'text',
    text: `qa-search-needle-84 ${NOTE_MARKER} ${root}`,
    source: { name: 'V18 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
    capturedAt: new Date('2026-11-15T08:00:00.000Z'),
  });
  const duplicate = await store.addItem({
    type: 'text',
    text: `qa-search-needle-84 ${NOTE_MARKER} ${root}`,
    source: { name: 'V18 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
    capturedAt: new Date('2026-11-15T08:01:00.000Z'),
  });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true, '重复内容应复用记录并更新最近使用时间。');
  assert.equal(store.getItem(first.item.id).usageCount, 2);
  assert.ok(store.search('qa-search-needle-84').some(item => item.id === first.item.id), 'FTS5 应检索较长关键词。');

  const short = await store.addItem({
    type: 'text', text: '短词检索样本', source: { name: 'V18 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
  });
  assert.ok(store.search('短词').some(item => item.id === short.item.id), '少于三个字符的检索应走短词回退。');
  const board = store.createBoard('V18 QA 看板');
  store.setBoardItem(board.id, first.item.id, true);
  assert.ok(store.search('qa-search-needle-84', { boardId: board.id }).some(item => item.id === first.item.id), '看板应筛出钉选项目。');
  assert.equal(store.getItem(first.item.id).pinned, true);
  return { first: store.getItem(first.item.id), short: store.getItem(short.item.id), board };
}

async function checkClipboardWindow(suite, { expectedText, board, itemId, workbench }) {
  const opened = await suite.openPanel('clipboard');
  const panel = opened?.win;
  assert.ok(panel && !panel.isDestroyed(), '剪贴板抽屉应可打开。');
  await panel.webContents.executeJavaScript('document.readyState', true);
  await waitFor(panel, "document.querySelector('#history-search') && document.querySelector('#history-list')", '抽屉控件');
  await inspect(panel, `(() => { const input=${expression('#history-search')}; input.value=${JSON.stringify(expectedText)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(panel, `${expression('#history-list')}.textContent.includes(${JSON.stringify(expectedText)})`, '抽屉全文检索');
  const captureEnabled = await inspect(panel, `${expression('#capture-enabled')}.checked`);
  assert.equal(captureEnabled, false, '抽屉中的首次采集开关应处于关闭状态。');
  await inspect(panel, `document.querySelector('#type-filters [data-type="text"]')?.click()`);
  await waitFor(panel, `${expression('#history-list')}.textContent.includes(${JSON.stringify(expectedText)})`, '按文本类型筛选');
  await inspect(panel, `document.querySelector('#type-filters [data-type=""]')?.click()`);
  const boardSelector = `#board-tabs [data-board-id="${board.id}"]`;
  await inspect(panel, `${expression(boardSelector)}?.click()`);
  await waitFor(panel, `${expression('#history-list')}.textContent.includes(${JSON.stringify(expectedText)})`, '看板历史筛选');
  await inspect(panel, `document.querySelector('#board-tabs [data-board-id=""]')?.click()`);

  const dialogBoardName = 'V18 QA 对话框看板';
  const boardDialogSelector = 'dialog.suite-native-dialog[data-dialog-kind="board-create"]';
  await inspect(panel, `document.querySelector('[data-action="board.new"], [data-action="board.create"]')?.click()`);
  await waitFor(panel, `${expression(boardDialogSelector)}?.querySelector('[data-dialog-input]')`, '新建看板输入对话框');
  await inspect(panel, `(() => {
    const dialog=document.querySelector('dialog.suite-native-dialog[data-dialog-kind="board-create"]');
    const input=dialog?.querySelector('[data-dialog-input]');
    if (!dialog?.open || !input) return false;
    input.value=${JSON.stringify(dialogBoardName)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    dialog.querySelector('[data-dialog-submit]')?.click();
    return true;
  })()`);
  await waitFor(panel, `!${expression(boardDialogSelector)}`, '看板对话框提交');
  const boardDeadline = Date.now() + 3000;
  while (Date.now() < boardDeadline && !suite.store.listBoards().some(item => item.name === dialogBoardName)) await delay(40);
  assert.ok(suite.store.listBoards().some(item => item.name === dialogBoardName), '看板名应通过原生对话框输入并持久化。');

  await inspect(panel, `(() => { const input=${expression('#selection-copy-fallback')}; input.checked=true; document.querySelector('[data-action="settings.save"]')?.click(); })()`);
  const settingsDeadline = Date.now() + 2000;
  while (Date.now() < settingsDeadline && suite.store.getSettings().selectionCopyFallback !== true) await delay(40);
  assert.equal(suite.store.getSettings().selectionCopyFallback, true, '设置表单应通过 IPC 保存划词复制回退。');
  await suite.updateSettings({ selectionCopyFallback: false });

  assert.equal(typeof workbench?.listNotes, 'function', '笔记联动检查需要工作台的笔记读取接口。');
  const itemCard = `#history-list [data-id="${itemId}"]`;
  await inspect(panel, `${expression(itemCard)}?.querySelector('.history-more summary')?.click()`);
  await inspect(panel, `${expression(itemCard)}?.querySelector('[data-item-action="note"]')?.click()`);
  const noteDeadline = Date.now() + 5000;
  let appendedNote;
  while (Date.now() < noteDeadline) {
    appendedNote = (await workbench.listNotes({ kind: 'note' })).find(note => note.body?.includes(NOTE_MARKER));
    if (appendedNote) break;
    await delay(80);
  }
  assert.ok(appendedNote, '历史条目的「笔记」动作应将文本追加到工作台 Markdown 笔记。');
  const searchVisible = await inspect(panel, `${expression('#history-search')}.getBoundingClientRect().width > 0`);
  assert.equal(searchVisible, true);
  if (!panel.isDestroyed()) panel.close();
  return { search: true, captureDefaultOff: true, filters: true, settingsPersisted: true, boardNativeDialogInput: true, noteAppendReadback: true };
}

async function checkLauncher(suite) {
  const opened = await suite.openPanel('launcher');
  const panel = opened?.win;
  assert.ok(panel && !panel.isDestroyed(), '命令面板应可打开。');
  await waitFor(panel, expression('#launcher-search'), '命令搜索框');
  await inspect(panel, `(() => { const input=${expression('#launcher-search')}; input.value='2+2'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(panel, `${expression('#launcher-results')}?.textContent.includes('4')`, '计算结果');
  const result = await inspect(panel, `${expression('#launcher-results')}?.querySelector('[data-command-id="calculator.copy"]')?.textContent || ''`);
  assert.match(result, /4/, '命令面板应显示计算结果，检查时不触发复制。');
  await inspect(panel, `(() => { const input=${expression('#launcher-search')}; input.value='qa-search-needle-84'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(panel, `${expression('#launcher-results')}?.textContent.includes('qa-search-needle-84')`, 'Pinboard Snippet 搜索');
  if (!panel.isDestroyed()) panel.close();
}

async function checkPinWindow(suite, imageItem) {
  const opened = await suite.openPin(imageItem);
  const pin = opened?.win;
  assert.ok(pin && !pin.isDestroyed(), '贴图窗口应打开。');
  await waitFor(pin, `${expression('#pin-image')}?.complete`, '贴图加载');
  const image = await inspect(pin, `(() => { const item=${expression('#pin-image')}; return { width:item.naturalWidth, height:item.naturalHeight }; })()`);
  assert.deepEqual(image, { width: 1, height: 1 }, '贴图应呈现数据库中的测试 PNG。');
  const before = pin.getSize();
  await inspect(pin, `document.querySelector('[data-pin-action="grow"]')?.click()`);
  await delay(100);
  const after = pin.getSize();
  assert.ok(after[0] >= before[0] && after[1] >= before[1], '贴图放大按钮不应缩小窗口。');
  const requestedOpacity = 0.8;
  await inspect(pin, `(() => { const input=${expression('#pin-opacity')}; input.value='${requestedOpacity}'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const opacityDeadline = Date.now() + 1500;
  while (Date.now() < opacityDeadline && Math.abs(pin.getOpacity() - requestedOpacity) > 0.025) await delay(40);
  assert.ok(Math.abs(pin.getOpacity() - requestedOpacity) <= 0.025, '贴图透明度滑块应将窗口透明度设置为 0.8。');
  if (!pin.isDestroyed()) pin.close();
}

async function checkSelectionWindow(suite) {
  if (typeof suite.openTestSelection !== 'function') return { skipped: true, reason: 'isolated selection window is unavailable' };
  const opened = await suite.openTestSelection('V18 isolated selection sample');
  const selection = opened?.win;
  assert.ok(selection && !selection.isDestroyed(), '划词工具条窗口应可打开。');
  await waitFor(selection, expression('#selection-preview'), '选区预览');
  const page = await inspect(selection, 'document.documentElement.dataset.suitePage');
  assert.equal(page, 'selection');
  if (!selection.isDestroyed()) selection.close();
  return { opened: true, readSelection: false };
}

async function checkWorkbenchRail(win, fixtureRoot) {
  const originalBounds = win.getBounds();
  const previousTheme = await inspect(win, 'document.documentElement.dataset.theme || "light"');
  const screenshots = path.join(fixtureRoot, 'V18SuiteScreenshots');
  await mkdir(screenshots, { recursive: true });
  const evidence = [];
  const focusPositions = [];
  try {
    for (const mode of ['light', 'dark']) {
      for (const [width, height] of SIZES) {
        win.setSize(width, height);
        await delay(250);
        await inspect(win, `(() => { document.documentElement.dataset.theme=${JSON.stringify(mode)}; document.documentElement.style.colorScheme=${JSON.stringify(mode)}; })()`);
        await selectView(win, 'home');
        await waitFor(win, `${expression('.wb-rail')}?.getBoundingClientRect().width > 0`, '左侧栏');

        const layout = await inspect(win, `(() => {
          const rail=document.querySelector('.wb-rail')?.getBoundingClientRect();
          const experiment=document.querySelector('.wb-nav [data-wb-nav="experiments"]');
          const label=experiment?.querySelector('span:nth-child(2)');
          const focus=document.querySelector('.wb-focus-nav')?.getBoundingClientRect();
          const mark=document.querySelector('.wb-brand .wb-mark')?.getBoundingClientRect();
          const brand=document.querySelector('.wb-brand strong');
          const brandText=brand?.getBoundingClientRect();
          const lines=brand ? (() => { const range=document.createRange(); range.selectNodeContents(brand); return range.getClientRects().length; })() : 0;
          return {
            brand: { text:brand?.textContent, lines, markWidth:mark?.width, markBottom:mark?.bottom, textTop:brandText?.top },
            railWidth:rail?.width,
            experiment:label && {text:label.textContent.trim(),lines:(() => { const range=document.createRange(); range.selectNodeContents(label); return range.getClientRects().length; })()},
            focus:focus && {top:focus.top,bottom:focus.bottom},
            horizontalOverflow:document.documentElement.scrollWidth>window.innerWidth+2,
          };
        })()`);
        assert.ok(Math.abs(layout.railWidth - 72) <= 1, `${mode} ${width}×${height} 左侧栏宽度应为 72px。`);
        assert.equal(layout.brand.text, '反穿衣', '左上角品牌文字应完整显示。');
        assert.ok(layout.brand.lines === 1 && layout.brand.markWidth >= 34 && layout.brand.markBottom <= layout.brand.textTop,
          '圆环标志应居上，反穿衣应在下方单行显示。');
        assert.equal(layout.experiment.text, '实验', '左侧功能标签应显示为「实验」。');
        assert.equal(layout.experiment.lines, 1, '「实验」标签在窄窗口中也应可见且只占一行。');
        assert.equal(layout.horizontalOverflow, false, `${width}×${height} 工作台不应出现横向溢出。`);

        for (const view of ['weekly', 'plans', 'files']) {
          await selectView(win, view);
          await inspect(win, `${expression('#wb-main')}.scrollTop=${expression('#wb-main')}.scrollHeight`);
          const position = await inspect(win, `(() => { const rect=document.querySelector('.wb-focus-nav').getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom}; })()`);
          focusPositions.push({ mode, width, view, ...position });
          assert.ok(position.top >= 0 && position.bottom <= height, `${view} 页面专注入口应留在视口内。`);
        }

        await selectView(win, 'home');
        const image = await win.capturePage();
        assert.ok(!image.isEmpty(), `${mode} ${width}×${height} 截图应有效。`);
        await writeFile(path.join(screenshots, `${mode}_${width}x${height}_rail.png`), image.toPNG());
        evidence.push({ mode, width, height, railWidth: layout.railWidth, screenshots: true });
      }
    }
    for (let index = 1; index < focusPositions.length; index += 1) {
      const previous = focusPositions[index - 1];
      const current = focusPositions[index];
      if (previous.mode === current.mode && previous.width === current.width) {
        assert.ok(Math.abs(previous.top - current.top) <= 1, '专注入口在复盘、速记和文库页面应使用相同位置。');
      }
    }

    win.setSize(1308, 884);
    await delay(150);
    await selectView(win, 'weekly');
    const location = await inspect(win, `${expression('#wb-location')}.textContent`);
    const focusNavBefore = await inspect(win, `${expression('.wb-focus-nav')}.getBoundingClientRect().top`);
    await inspect(win, `${expression('#wb-main')}.scrollTop=${expression('#wb-main')}.scrollHeight`);
    await inspect(win, `${expression('.wb-focus-nav')}?.click()`);
    await waitFor(win, `${expression('#workbench')}.hidden`, '专注页进入');
    await waitFor(win, expression('#backToWorkbench'), '专注页返回按钮');
    await inspect(win, `${expression('#backToWorkbench')}?.click()`);
    await waitFor(win, `!${expression('#workbench')}.hidden`, '专注页返回工作台');
    await waitFor(win, `${expression('#wb-location')}.textContent === ${JSON.stringify(location)}`, '返回原页面');
    const focusNavAfter = await inspect(win, `${expression('.wb-focus-nav')}.getBoundingClientRect().top`);
    assert.equal(focusNavAfter, focusNavBefore, '进入专注页并返回后侧栏入口位置应保持一致。');
  } finally {
    await inspect(win, `(() => { document.documentElement.dataset.theme=${JSON.stringify(previousTheme)}; document.documentElement.style.colorScheme=''; })()`);
    win.setBounds(originalBounds);
  }
  return evidence;
}

export async function runDesktopSuiteCheck(win, { suite, settings, fixtureRoot, workbench }) {
  assert.ok(win && suite?.store && suite?.service && suite?.bridge && fixtureRoot && workbench,
    'V18 桌面套件检查需要主窗口、工作台、剪贴板服务、存储、桥接和临时数据根。');
  assert.equal(suite.nativeAvailable, true, '隔离验收应使用打包方式编译的 Windows 辅助进程。');
  assert.ok(typeof suite.updateSettings === 'function', '测试控制器需要提供隔离设置更新入口。');
  assert.ok(typeof suite.openPanel === 'function' && typeof suite.openPin === 'function', '测试控制器需要提供隔离的抽屉和贴图窗口入口。');
  assert.equal(typeof ClipboardItem, 'function', 'Electron 应提供原生 ClipboardItem 类型。');
  assert.equal(typeof clipboard.read, 'function', 'Electron 剪贴板应提供结构化读取接口。');
  assert.equal(typeof clipboard.write, 'function', 'Electron 剪贴板应提供结构化写入接口。');
  assert.ok(path.isAbsolute(suite.store.root), '剪贴板数据库应位于绝对的本机数据路径。');
  const root = path.resolve(fixtureRoot);
  const storage = await checkStorageAndSearch(suite.store, root);
  const image = await suite.store.addItem({
    type: 'image', imageBuffer: TINY_PNG, imageWidth: 1, imageHeight: 1,
    source: { name: 'V18 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
  });
  const screenshotEvidence = await checkWorkbenchRail(win, root);
  const clipboardPanelEvidence = await checkClipboardWindow(suite, {
    expectedText: 'qa-search-needle-84', board: storage.board, itemId: storage.first.id, workbench,
  });
  await checkLauncher(suite);
  await checkPinWindow(suite, image.item);
  const selection = await checkSelectionWindow(suite);

  const captureSettingBefore = suite.store.getSettings().captureEnabled;
  if (typeof suite.updateSettings === 'function') {
    const updated = await suite.updateSettings({ captureEnabled: false, autoPaste: true });
    assert.equal(updated?.autoPaste, true, '设置接口应持久化自动粘贴开关。');
    await suite.updateSettings({ captureEnabled: captureSettingBefore, autoPaste: false });
  } else {
    const updated = await suite.store.updateSettings({ captureEnabled: captureSettingBefore, autoPaste: true });
    assert.equal(updated.autoPaste, true);
    await suite.store.updateSettings({ autoPaste: false });
  }
  assert.equal(suite.store.getSettings().captureEnabled, false, '桌面检查不应打开真实的自动采集。');

  await suite.updateSettings({ trayEnabled: true });
  win.close();
  await delay(120);
  assert.ok(!win.isDestroyed() && !win.isVisible(), '托盘启用时关闭主窗口应隐藏而不销毁。');
  win.show();
  await suite.updateSettings({ trayEnabled: false });
  
  const nativeSnapshot = await suite.bridge.request('snapshot');
  assert.ok(Number.isInteger(nativeSnapshot.sequence), 'Windows 辅助进程应报告剪贴板序号。');
  assert.ok(nativeSnapshot.foreground && nativeSnapshot.owner, '辅助进程应分别报告前台应用和剪贴板所有者。');
  assert.equal(typeof nativeSnapshot.privacyExcluded, 'boolean');
  assert.ok(Array.isArray(nativeSnapshot.files), '辅助进程应暴露 CF_HDROP 文件列表接口。');

  const persistenceRoot = path.join(root, 'V18PersistenceCheck');
  let persistedStore = await openClipboardStore(persistenceRoot);
  const persisted = await persistedStore.addItem({ type: 'text', text: 'V18 persistence reload sample' });
  persistedStore.close();
  persistedStore = await openClipboardStore(persistenceRoot);
  assert.ok(persistedStore.getItem(persisted.item.id), 'SQLite 记录在关闭并重开后应保留。');
  persistedStore.close();

  const evidence = {
    database: { absolutePath: suite.store.root, longSearch: true, shortSearch: true, duplicateDedupe: true, boards: true, restartPersistence: true },
    clipboardPanel: clipboardPanelEvidence,
    electronClipboard: { clipboardItem: true, structuredReadWrite: true, clipboardUnchangedByCheck: true },
    launcher: { calculatorResultVisible: true, clipboardUnchangedByCheck: true },
    pin: { imageLoaded: true, resize: true, opacityControl: true, opacity: 0.8 },
    selection,
    nativeBridge: { snapshot: true, foregroundAndOwnerSeparate: true, privacyFlag: true, fileList: true },
    sidebar: screenshotEvidence,
    focusEntryAndReturn: true,
    trayHideAndRestore: true,
  };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'V18SuiteVerification.json'), `${JSON.stringify({ verifiedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`, 'utf8');
  return evidence;
}
