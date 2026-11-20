import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const marker = 'V23_CLIPBOARD_PAGE_QA';

function expression(selector) {
  return `document.querySelector(${JSON.stringify(selector)})`;
}

async function inspect(win, source) {
  return win.webContents.executeJavaScript(source, true);
}

async function waitFor(win, source, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await inspect(win, source)) return;
    await delay(50);
  }
  throw new Error(`V23 剪贴板验收等待超时：${label}`);
}

async function checkWorkbenchPage(win) {
  const root = '#wb-clipboard';
  await waitFor(win, `${expression(root)} && !${expression(root)}.hidden`, '工作台剪贴板页');
  await waitFor(win, `${expression(root + ' [data-cp-list]')}?.textContent.includes(${JSON.stringify(marker)})`, '夹具历史记录');
  const status = await inspect(win, `(() => {
    const row = [...document.querySelectorAll('#wb-clipboard [data-cp-list] .clipboard-workspace__row')].find(item => item.textContent.includes(${JSON.stringify(marker)}));
    const button = ${expression(root + ' [data-cp-copy-selected]')};
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (!row || !button || !checkbox) return null;
    const initial = button.disabled;
    checkbox.click();
    const enabledAfterSelection = !button.disabled;
    checkbox.click();
    const disabledAfterClear = button.disabled;
    return { initial, enabledAfterSelection, disabledAfterClear, userSelect: getComputedStyle(row.querySelector('.clipboard-workspace__open span')).userSelect };
  })()`);
  assert.deepEqual(status, { initial: true, enabledAfterSelection: true, disabledAfterClear: true, userSelect: 'auto' },
    '批量复制应随选择状态启用，历史文字应保持可选。');
  await inspect(win, `(() => {
    const row = [...document.querySelectorAll('#wb-clipboard [data-cp-list] .clipboard-workspace__row')].find(item => item.textContent.includes(${JSON.stringify(marker)}));
    row?.querySelector('.clipboard-workspace__open')?.click();
  })()`);
  await waitFor(win, `${expression(root + ' [data-cp-detail]')}?.textContent.includes(${JSON.stringify(marker)})`, '历史详情');
  const searchResult = await inspect(win, `(() => {
    const input = ${expression(root + ' [data-cp-search]')};
    if (!input) return false;
    input.value = ${JSON.stringify(marker)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(searchResult, true);
  await waitFor(win, `${expression(root + ' [data-cp-list]')}?.textContent.includes(${JSON.stringify(marker)})`, '全文搜索');
  return { fixtureRows: true, selectionEnablesBatch: true, textSelectionEnabled: true, detail: true, search: true };
}

async function checkPopup(suite, settings, fixtureRoot) {
  const opened = await suite.openPanel('clipboard');
  const popup = opened?.win;
  assert.ok(popup && !popup.isDestroyed(), 'Alt+V 剪贴板面板应可打开。');
  await waitFor(popup, `${expression('.clipboard-titlebar')} && ${expression('.suite-window-controls button[data-window-command="maximize"]')}`, '浮窗标题栏和圆按钮');

  const appearance = settings?.getAppearance?.() ?? settings?.appearance ?? {};
  const visual = await inspect(popup, `(() => {
    const titlebar = ${expression('.clipboard-titlebar')};
    const buttons = [...document.querySelectorAll('.suite-window-controls button')];
    const shell = document.querySelector('.clipboard-shell');
    const rootStyle = getComputedStyle(document.querySelector('.clipboard-shell'));
    const text = document.querySelector('.history-card .history-text');
    const card = document.querySelector('.history-card');
    return {
      dragRegion: getComputedStyle(titlebar).webkitAppRegion,
      edgeDragRegion: getComputedStyle(shell, '::after').webkitAppRegion,
      controls: buttons.map(button => ({ command: button.dataset.windowCommand, region: getComputedStyle(button).webkitAppRegion })),
      buttonRadii: buttons.map(button => getComputedStyle(button).borderRadius),
      radius: rootStyle.borderRadius,
      theme: document.documentElement.dataset.theme,
      palette: document.documentElement.dataset.palette,
      material: document.documentElement.dataset.material,
      textSelection: text ? getComputedStyle(text).userSelect : 'auto',
      hoverSupported: Boolean(card && card.matches(':hover')),
    };
  })()`);
  assert.equal(visual.dragRegion, 'drag');
  assert.equal(visual.edgeDragRegion, 'drag');
  assert.deepEqual(visual.controls.map(control => control.command), ['close', 'minimize', 'maximize']);
  assert.ok(visual.controls.every(control => control.region === 'no-drag'));
  assert.ok(visual.buttonRadii.every(radius => radius === '50%'));
  assert.match(visual.radius, /16px/);
  assert.equal(visual.textSelection, 'auto');
  const cardBounds = await inspect(popup, `(() => { const rect=${expression('.history-card')}.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`);
  popup.webContents.sendInputEvent({ type: 'mouseMove', x: cardBounds.x, y: cardBounds.y });
  await delay(40);
  visual.hoverSupported = await inspect(popup, `${expression('.history-card')}?.matches(':hover')`);
  assert.equal(visual.hoverSupported, true, '历史记录卡片应响应鼠标悬停。');
  if (appearance?.mode) assert.ok(['light', 'dark'].includes(visual.theme));

  const originalBounds = popup.getNormalBounds();
  const target = { x: originalBounds.x + 31, y: originalBounds.y + 27 };
  popup.setPosition(target.x, target.y);
  await delay(80);
  const movedBounds = popup.getNormalBounds();
  await inspect(popup, `document.querySelector('[data-window-command="minimize"]')?.click()`);
  await delay(100);
  const minimized = popup.isMinimized();
  if (minimized) popup.restore();
  await delay(100);
  await inspect(popup, `document.querySelector('[data-window-command="maximize"]')?.click()`);
  await delay(100);
  const maximized = popup.isMaximized();
  if (maximized) popup.unmaximize();
  await delay(100);
  popup.hide();
  await delay(60);
  const reopened = await suite.openPanel('clipboard');
  assert.equal(reopened.win, popup, '重开 Alt+V 应复用同一个浮窗。');
  const restoredBounds = popup.getNormalBounds();
  assert.equal(restoredBounds.x, movedBounds.x, '重开浮窗应保留拖动后的水平位置。');
  assert.equal(restoredBounds.y, movedBounds.y, '重开浮窗应保留拖动后的垂直位置。');
  assert.equal(minimized, true, '黄色控制应最小化浮窗。');
  assert.equal(maximized, true, '绿色控制应最大化浮窗。');
  await writeFile(path.join(fixtureRoot, 'Clipboard_Popup_CodexV23.png'), (await popup.webContents.capturePage()).toPNG());
  return { appearance: visual, minimized, maximized, retainedPosition: { before: movedBounds, after: restoredBounds } };
}

async function checkSelectedDeletion(win, suite, fixtureRoot) {
  const root = '#wb-clipboard';
  const removalMarker = `${marker} deletion fixture`;
  const board = suite.store.createBoard(`${marker} deletion board`);
  const entries = await Promise.all(['first', 'second'].map(label => suite.store.addItem({
    type: 'text', text: `${removalMarker} ${label}`,
    source: { name: 'V23 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' }, boardId: board.id,
  })));
  const ids = entries.map(entry => entry.item.id);
  const search = await inspect(win, `(() => {
    const input = ${expression(root + ' [data-cp-search]')};
    input.value = ${JSON.stringify(removalMarker)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(search, true);
  await waitFor(win, `${expression(root + ' [data-cp-list]')}?.querySelectorAll('.clipboard-workspace__row').length === 2`, '待删除夹具');
  await inspect(win, `(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(root + ' [data-cp-list] .clipboard-workspace__row')})];
    rows.forEach(row => row.querySelector('input[type="checkbox"]').click());
    return ${expression(root + ' [data-cp-delete-selected]')}.disabled === false;
  })()`);
  assert.equal(await inspect(win, `${expression(root + ' [data-cp-delete-selected]')}.disabled`), false);
  await inspect(win, `${expression(root + ' [data-cp-delete-selected]')}.click()`);
  await waitFor(win, `${expression(root + ' [data-cp-delete-dialog]')}.open`, '删除确认框');
  await inspect(win, `${expression(root + ' [data-cp-delete-dialog] button[value="cancel"]')}.click()`);
  await waitFor(win, `!${expression(root + ' [data-cp-delete-dialog]')}.open`, '取消删除');
  assert.equal(await inspect(win, `${expression(root + ' [data-cp-selected-count]')}.textContent`), '已选择 2 条', '取消后保留所选状态');
  assert.equal((await suite.store.search(removalMarker, { limit: 10 })).length, 2, '取消不得删除记录');

  await inspect(win, `${expression(root + ' [data-cp-list] .clipboard-workspace__row .clipboard-workspace__open')}.click()`);
  await waitFor(win, `${expression(root + ' [data-cp-detail]')}?.textContent.includes(${JSON.stringify(removalMarker)})`, '删除前详情');
  await inspect(win, `${expression(root + ' [data-cp-delete-selected]')}.click()`);
  await waitFor(win, `${expression(root + ' [data-cp-delete-dialog]')}.open`, '再次确认删除');
  await inspect(win, `${expression(root + ' [data-cp-delete-dialog] button[value="delete"]')}.click()`);
  await waitFor(win, `${expression(root + ' [data-cp-list]')}?.textContent.includes('没有匹配的剪贴板记录。')`, '删除刷新列表');
  assert.equal((await suite.store.search(removalMarker, { limit: 10 })).length, 0, '所选记录已从历史删除');
  assert.equal(suite.store.listBoards().find(item => item.id === board.id)?.itemCount, 0, '删除记录清理看板关联');
  assert.equal(await inspect(win, `${expression(root + ' [data-cp-detail]')}.textContent`), '选择一条记录查看详情。', '删除详情中的记录后清空详情');
  const result = { cancelPreservesSelection: true, selectedRecordsDeleted: ids.length, boardItemsAfterDelete: 0, detailCleared: true };
  await writeFile(path.join(fixtureRoot, 'Clipboard_Delete_Check_CodexV23.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

async function checkPartialDeletion(win) {
  const result = await inspect(win, `(async () => {
    const { setupClipboardPage } = await import('/clipboard-page.mjs');
    const mount = document.createElement('div');
    document.body.append(mount);
    const callLog = [];
    const records = [{ id: 'succeed', type: 'text', text: '成功' }, { id: 'fail', type: 'text', text: '失败' }];
    try {
      setupClipboardPage(mount, { api: { async invoke(operation, input) {
        if (operation === 'boards.list') return [];
        if (operation === 'history.search') return [...records];
        if (operation !== 'history.delete') throw new Error('意外剪贴板操作');
        callLog.push(input.id);
        if (input.id === 'fail') throw new Error('合成删除失败');
        records.shift();
        return true;
      } } });
      await new Promise(resolve => requestAnimationFrame(resolve));
      mount.querySelectorAll('[data-item-id] input').forEach(checkbox => checkbox.click());
      mount.querySelector('[data-cp-delete-selected]').click();
      mount.querySelector('[data-cp-delete-dialog] button[value=delete]').click();
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const status = mount.querySelector('[data-cp-status]').textContent;
        if (status.includes('合成删除失败')) return {
          calls: callLog, failedStillSelected: mount.querySelector('[data-item-id=fail] input')?.checked,
          successRemoved: !mount.querySelector('[data-item-id=succeed]'),
        };
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return null;
    } finally {
      mount.remove();
    }
  })()`);
  assert.deepEqual(result, { calls: ['succeed', 'fail'], failedStillSelected: true, successRemoved: true });
}

export async function runClipboardPageCheck(win, { suite, settings, fixtureRoot }) {
  assert.ok(win && suite?.store && suite?.openPanel && fixtureRoot,
    'V23 剪贴板检查需要主窗口、隔离套件和夹具数据根。');
  assert.equal(suite.store.getSettings().captureEnabled, false, '隔离剪贴板检查不应开启真实采集。');

  const first = await suite.store.addItem({
    type: 'text', text: `${marker} first row`, source: { name: 'V23 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
  });
  const second = await suite.store.addItem({
    type: 'link', text: 'https://example.invalid/v23-clipboard', source: { name: 'V23 QA', process: 'qa.exe', foregroundProcess: 'qa.exe' },
  });
  assert.ok(first.item.id && second.item.id);

  const rendererApi = await inspect(win, 'typeof window.stilltimeDesktop.desktopSuite?.invokeClipboard');
  assert.equal(rendererApi, 'function', '主窗口 preload 应暴露受限剪贴板 API。');
  const matches = await inspect(win, `window.stilltimeDesktop.desktopSuite.invokeClipboard('history.search', { query: ${JSON.stringify(marker)}, limit: 10 })`);
  assert.ok(matches.some(item => item.id === first.item.id), '主窗口角色应可以搜索剪贴板夹具。');
  const restricted = await inspect(win, `Promise.all([
    window.stilltimeDesktop.desktopSuite.invokeClipboard('window.control', { command: 'minimize' }).then(() => false, error => /不能从工作台剪贴页调用/.test(error.message)),
    window.stilltimeDesktop.desktopSuite.invokeClipboard('history.paste', { id: ${JSON.stringify(first.item.id)} }).then(() => false, error => /不能从工作台剪贴页调用/.test(error.message)),
    window.stilltimeDesktop.desktopSuite.invokeClipboard('history.action', { id: ${JSON.stringify(first.item.id)}, action: 'reveal' }).then(() => false, error => /仅在剪贴板浮窗中可用/.test(error.message)),
  ])`);
  assert.deepEqual(restricted, [true, true, true], '主窗口不得调用浮窗专属操作或自动粘贴。');

  await inspect(win, 'document.querySelector(\'[data-wb-nav="clipboard"]\').click()');
  const page = await checkWorkbenchPage(win);
  const popup = await checkPopup(suite, settings, fixtureRoot);
  await inspect(win, 'document.querySelector(\'[data-wb-nav="clipboard"]\').click()');
  await waitFor(win, `${expression('#wb-clipboard')} && !${expression('#wb-clipboard')}.hidden`, '返回剪贴板页');
  const deletion = await checkSelectedDeletion(win, suite, fixtureRoot);
  await checkPartialDeletion(win);
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(path.join(fixtureRoot, 'Clipboard_Page_Check_CodexV23.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), mainRoleSearch: true, popupOnlyOperationsRejected: true,
    automaticCaptureRemainedDisabled: true, page, popup, deletion, partialFailurePreservesSelection: true,
  }, null, 2) + '\n', 'utf8');
  return { mainRoleSearch: true, popupOnlyOperationsRejected: true, automaticCaptureRemainedDisabled: true, page, popup, deletion };
}
