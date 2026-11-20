const desktop = window.desktopSuite;
const page = document.documentElement.dataset.suitePage;
const $ = selector => document.querySelector(selector);
let toastTimer;

desktop.onChanged(value => {
  if (value?.appearance === 'dark' || value?.appearance === 'light') {
    document.documentElement.dataset.theme = value.appearance;
    document.documentElement.style.colorScheme = value.appearance;
  }
  if (typeof value?.palette === 'string') document.documentElement.dataset.palette = value.palette;
  if (value?.material === 'solid' || value?.material === 'glass') document.documentElement.dataset.material = value.material;
  if (Number.isFinite(value?.glassBlur)) document.documentElement.style.setProperty('--suite-blur-radius', `${Math.max(0, Math.min(48, value.glassBlur))}px`);
});

function showToast(message, error = false) {
  const target = $('#suite-toast');
  if (!target) return;
  target.textContent = String(message ?? '');
  target.dataset.error = String(error);
  target.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove('is-visible'), 2600);
}

function button(label, action, attributes = {}) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.dataset.action = action;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

async function invoke(operation, payload) {
  try {
    return await desktop.invoke(operation, payload);
  } catch (error) {
    showToast(error?.message || '操作失败，请重试。', true);
    throw error;
  }
}

function hideWindow() {
  void invoke('window.hide', {});
}

function showNativeDialog({ title, label, value = '', confirmLabel = '确定', cancelLabel = '取消', confirmOnly = false, required = false, kind = 'input' }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'suite-native-dialog';
    dialog.dataset.dialogKind = kind;
    dialog.setAttribute('aria-labelledby', 'suite-dialog-title');
    const form = document.createElement('form'); form.method = 'dialog';
    const heading = document.createElement('h2'); heading.id = 'suite-dialog-title'; heading.textContent = title; form.append(heading);
    let input;
    if (!confirmOnly) {
      const fieldLabel = document.createElement('label'); fieldLabel.textContent = label;
      input = document.createElement('input'); input.type = 'text'; input.value = value; input.maxLength = 120; input.required = required; input.autocomplete = 'off';
      input.dataset.dialogInput = '';
      fieldLabel.append(input); form.append(fieldLabel);
    } else {
      const message = document.createElement('p'); message.textContent = label; form.append(message);
    }
    const actions = document.createElement('div'); actions.className = 'suite-native-dialog__actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = cancelLabel; cancel.dataset.dialogCancel = '';
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = confirmLabel; confirm.className = 'is-primary'; confirm.dataset.dialogSubmit = '';
    actions.append(cancel, confirm); form.append(actions); dialog.append(form); document.body.append(dialog);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove(); resolve(result);
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); finish(null); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const result = confirmOnly ? true : input.value.trim();
      if (!confirmOnly && required && !result) { input.focus(); return; }
      finish(result);
    });
    dialog.showModal();
    if (input) { input.focus(); input.select(); } else confirm.focus();
  });
}

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function validColor(value) {
  const color = String(value ?? '').trim();
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) return color;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i.exec(color);
  if (!rgb || rgb.slice(1, 4).some(channel => Number(channel) > 255)) return null;
  if (rgb[4] !== undefined && (Number(rgb[4]) < 0 || Number(rgb[4]) > 1)) return null;
  return color;
}

async function clipboardPage() {
  const privacyNotice = document.createElement('small');
  privacyNotice.className = 'capture-privacy-notice';
  privacyNotice.textContent = '浏览器复制的密码和普通验证码仍可能被记录。';
  $('#capture-enabled').previousElementSibling.append(privacyNotice);
  const queryInput = $('#history-search');
  const list = $('#history-list');
  const empty = $('#history-empty');
  const boardTabs = $('#board-tabs');
  const filters = $('#type-filters');
  const filter = { query: '', type: '', boardId: '' };
  let rows = [];
  let selected = 0;
  let timer;
  let searchGeneration = 0;
  const historyLimit = 150;

  async function refreshHistory({ append = false } = {}) {
    const request = ++searchGeneration;
    const offset = append ? rows.length : 0;
    if (!append) selected = 0;
    const result = await invoke('history.search', { ...filter, limit: historyLimit, offset });
    if (request !== searchGeneration) return;
    const pageRows = Array.isArray(result) ? result : [];
    rows = append ? rows.concat(pageRows) : pageRows;
    if (append && pageRows.length === 0) $('#history-load-more').hidden = true;
    else $('#history-load-more').hidden = pageRows.length < historyLimit;
    selected = Math.max(0, Math.min(selected, rows.length - 1));
    renderRows();
    await refreshStack();
  }

  async function refreshStack() {
    const state = await invoke('stack.state', {});
    const enabled = Boolean(state?.stackEnabled ?? state?.enabled);
    const queue = Array.isArray(state?.items) ? state.items
      : Array.isArray(state?.stackItems) ? state.stackItems : Array.isArray(state?.queue) ? state.queue : [];
    const queueLength = Number.isInteger(state?.length) ? state.length
      : Number.isInteger(state?.stackLength) ? state.stackLength
        : Number.isInteger(state?.queueLength) ? state.queueLength : queue.length;
    $('#stack-toggle').setAttribute('aria-pressed', String(enabled));
    $('#stack-toggle').textContent = enabled ? '顺序栈 · ' + queueLength : '顺序栈';
    $('#stack-panel').hidden = !enabled;
    const current = queue[0];
    const preview = $('#stack-preview');
    preview.textContent = !enabled ? '' : current
      ? '当前：' + (current.preview || current.text || current.content?.text || '已排队内容') + (queueLength > 1 ? ' · 其后还有 ' + (queueLength - 1) + ' 项' : ' · 最后一项')
      : queueLength > 0 ? '顺序栈有 ' + queueLength + ' 项待粘贴' : '开启后，接下来复制的内容会依次入栈';
    const next = $('[data-action="stack.next"]');
    next.disabled = queueLength === 0;
    next.title = next.disabled ? '顺序栈当前没有待粘贴项' : '写回并尝试粘贴队首';
  }

  function renderRows() {
    list.replaceChildren();
    empty.hidden = rows.length !== 0;
    for (const [index, item] of rows.entries()) {
      const card = document.createElement('article');
      card.className = 'history-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(index === selected));
      card.dataset.id = item.id;
      const preview = document.createElement('button');
      preview.className = 'history-preview';
      preview.type = 'button';
      preview.title = '选择并粘贴。按住 Shift 以纯文本粘贴';
      preview.addEventListener('click', event => void pasteItem(item, event.shiftKey));
      const type = document.createElement('span');
      type.className = 'history-type';
      type.textContent = ({ text: '文', link: '链', image: '图', files: '档', color: '色', html: '富', rtf: '富' })[item.type] || '文';
      const sourceIcon = document.createElement('span');
      sourceIcon.className = 'history-source-icon';
      sourceIcon.setAttribute('aria-hidden', 'true');
      if (item.sourceIcon) {
        const icon = document.createElement('img');
        icon.src = item.sourceIcon;
        icon.alt = '';
        icon.addEventListener('error', () => {
          icon.remove();
          sourceIcon.textContent = '▣';
          sourceIcon.classList.add('is-generic');
        }, { once: true });
        sourceIcon.append(icon);
      } else {
        sourceIcon.textContent = '▣';
        sourceIcon.classList.add('is-generic');
      }
      preview.append(sourceIcon, type);
      if (item.type === 'image' && item.imageUrl) {
        const image = document.createElement('img');
        image.className = 'history-image';
        image.src = item.imageUrl;
        image.alt = '剪贴板图片 ' + (item.width || '') + ' × ' + (item.height || '');
        preview.append(image);
      } else {
        const text = document.createElement('span');
        text.className = 'history-text';
        text.textContent = item.preview || item.text || item.url || (Array.isArray(item.paths) ? item.paths.join(' · ') : item.name) || '没有可预览的内容';
        preview.append(text);
      }
      const colorValue = validColor(item.text || item.preview);
      if (item.type === 'color' && colorValue) {
        const swatch = document.createElement('span');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = colorValue;
        preview.prepend(swatch);
      }
      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const previewText = item.text || item.preview || '';
      const characterCount = Number.isInteger(item.characterCount) ? item.characterCount : Array.from(previewText).length;
      meta.textContent = [item.sourceName || item.sourceProcess || '来源未知', localTime(item.updatedAt || item.createdAt),
        item.type === 'image' ? (item.width || 0) + ' × ' + (item.height || 0) : characterCount + ' 字'].filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      actions.append(button('粘贴', 'history.paste', { 'data-item-id': item.id }));
      actions.append(button('纯文本', 'history.plain', { 'data-item-id': item.id, title: '去除 HTML 和 RTF 格式后粘贴' }));
      if (item.type !== 'image' && item.type !== 'files') actions.append(button('复制纯文本', 'history.copyText', { 'data-item-id': item.id, title: '只写入剪贴板，不切换焦点' }));
      actions.append(button(item.pinned ? '取消置顶' : '置顶', 'history.pin', { 'data-item-id': item.id, 'aria-pressed': String(Boolean(item.pinned)) }));
      const more = document.createElement('details');
      more.className = 'history-more';
      const summary = document.createElement('summary');
      summary.textContent = '更多';
      const moreActions = document.createElement('div');
      moreActions.className = 'history-more-actions';
      for (const [label, action] of [['笔记', 'note'], ['翻译', 'translate'], ['贴图', 'pin'], ['显示位置', 'reveal'], ['工作台打开', 'open'], ['删除', 'delete']]) {
        moreActions.append(button(label, 'history.action', { 'data-item-id': item.id, 'data-item-action': action }));
      }
      if (item.type === 'link') moreActions.prepend(button('收录文章', 'history.action', { 'data-item-id': item.id, 'data-item-action': 'collect' }));
      more.append(summary, moreActions);
      actions.append(more);
      card.append(preview, meta, actions);
      card.addEventListener('focus', () => { selected = index; });
      card.addEventListener('dragstart', event => {
        event.dataTransfer.setData('application/x-stilltime-history-id', item.id);
        event.dataTransfer.effectAllowed = 'copy';
      });
      card.draggable = true;
      list.append(card);
    }
  }

  async function pasteItem(item, plainText = false) {
    await invoke('history.paste', { id: item.id, plainText });
  }

  async function renderBoards() {
    const result = await invoke('boards.list', {});
    const boards = Array.isArray(result) ? result : [];
    boardTabs.replaceChildren();
    const all = button('全部历史', 'board.filter', { 'aria-pressed': String(!filter.boardId) });
    all.dataset.boardId = '';
    boardTabs.append(all);
    for (const board of boards) {
      const group = document.createElement('span');
      group.className = 'board-group';
      const tab = button(board.name, 'board.filter', { 'aria-pressed': String(filter.boardId === board.id), title: board.name });
      tab.dataset.boardId = board.id;
      tab.addEventListener('dragover', event => { event.preventDefault(); tab.classList.add('is-drop-target'); });
      tab.addEventListener('dragleave', () => tab.classList.remove('is-drop-target'));
      tab.addEventListener('drop', event => {
        event.preventDefault();
        tab.classList.remove('is-drop-target');
        const itemId = event.dataTransfer.getData('application/x-stilltime-history-id');
        if (itemId) void invoke('boards.set', { itemId, boardId: board.id, pinned: true }).then(() => refreshHistory());
      });
      const manage = document.createElement('details');
      manage.className = 'board-manage';
      const summary = document.createElement('summary');
      summary.setAttribute('aria-label', '管理看板 ' + board.name);
      summary.textContent = '···';
      const menu = document.createElement('span');
      menu.className = 'board-manage-menu';
      menu.append(button('重命名', 'board.rename', { 'data-board-id': board.id }));
      menu.append(button('删除', 'board.delete', { 'data-board-id': board.id }));
      manage.append(summary, menu);
      group.append(tab, manage);
      boardTabs.append(group);
    }
    boardTabs.append(button('+ 新建看板', 'board.create'));
  }

  filters.addEventListener('click', event => {
    const target = event.target.closest('[data-type]');
    if (!target) return;
    filter.type = target.dataset.type || '';
    filters.querySelectorAll('[data-type]').forEach(item => item.setAttribute('aria-pressed', String(item === target)));
    void refreshHistory();
  });
  boardTabs.addEventListener('click', async event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'board.filter') {
      filter.boardId = target.dataset.boardId || '';
      await renderBoards();
      await refreshHistory();
    } else if (target.dataset.action === 'board.create') {
      const name = await showNativeDialog({ title: '新建看板', label: '看板名称', confirmLabel: '创建', required: true, kind: 'board-create' });
      if (name?.trim()) { await invoke('boards.create', { name: name.trim() }); await renderBoards(); showToast('看板已创建。'); }
    } else if (target.dataset.action === 'board.rename') {
      const board = (await invoke('boards.list', {})).find(item => item.id === target.dataset.boardId);
      const name = board && await showNativeDialog({ title: '重命名看板', label: '看板名称', value: board.name, confirmLabel: '保存', required: true, kind: 'board-rename' });
      if (name?.trim()) { await invoke('boards.rename', { id: board.id, name: name.trim() }); await renderBoards(); showToast('看板名称已更新。'); }
    } else if (target.dataset.action === 'board.delete') {
      const board = (await invoke('boards.list', {})).find(item => item.id === target.dataset.boardId);
      if (!board || !await showNativeDialog({ title: '删除看板', label: '删除“' + board.name + '”？其中的条目会从该看板移除。', confirmLabel: '删除', confirmOnly: true, kind: 'board-delete' })) return;
      await invoke('boards.delete', { id: board.id });
      if (filter.boardId === board.id) filter.boardId = '';
      await renderBoards();
      await refreshHistory();
      showToast('看板已删除，历史条目已从看板移除。');
    }
  });
  queryInput.addEventListener('input', () => {
    clearTimeout(timer);
    filter.query = queryInput.value;
    timer = setTimeout(() => void refreshHistory(), 85);
  });
  $('#stack-toggle').addEventListener('click', async () => {
    const state = await invoke('stack.state', {});
    await invoke('stack.set', { enabled: !Boolean(state?.stackEnabled ?? state?.enabled) });
    await refreshStack();
  });
  $('#history-load-more').addEventListener('click', async event => {
    const control = event.currentTarget;
    control.disabled = true;
    control.textContent = '正在加载…';
    try { await refreshHistory({ append: true }); }
    catch { /* invoke already reports the load error. */ }
    finally { control.disabled = false; control.textContent = '加载更多记录'; }
  });
  $('[data-action="stack.next"]').addEventListener('click', async () => {
    const result = await invoke('stack.paste', {});
    if (result?.written) showToast(result.pasted ? '已粘贴顺序栈下一项。' : '内容已写入剪贴板，可手动粘贴。');
    else if (result?.empty) showToast('顺序粘贴栈已清空。');
    await refreshStack();
  });
  list.addEventListener('click', async event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const id = target.dataset.itemId;
    if (target.dataset.action === 'history.paste') {
      const item = rows.find(row => row.id === id);
      if (item) await pasteItem(item, false);
    } else if (target.dataset.action === 'history.plain') {
      const item = rows.find(row => row.id === id);
      if (item) await pasteItem(item, true);
    } else if (target.dataset.action === 'history.copyText') {
      await invoke('history.action', { id, action: 'copy' });
      showToast('纯文本已复制。');
    } else if (target.dataset.action === 'history.pin') {
      const item = rows.find(row => row.id === id);
      const boards = await invoke('boards.list', {});
      if (item?.pinned) {
        const selectedBoards = filter.boardId ? [filter.boardId] : boards.map(board => board.id);
        for (const boardId of selectedBoards) await invoke('boards.set', { itemId: id, boardId, pinned: false });
      } else if (!boards.length) {
        const name = await showNativeDialog({ title: '新建看板', label: '看板名称', confirmLabel: '创建并置顶', required: true, kind: 'board-create-pin' });
        if (name?.trim()) {
          const created = await invoke('boards.create', { name: name.trim() });
          await invoke('boards.set', { itemId: id, boardId: created.id, pinned: true });
        }
      } else {
        const chosen = boards.find(board => board.id === filter.boardId) || boards[0];
        await invoke('boards.set', { itemId: id, boardId: chosen.id, pinned: true });
      }
      await renderBoards();
      await refreshHistory();
    } else if (target.dataset.action === 'history.action') {
      const action = target.dataset.itemAction;
      if (action === 'delete') {
        if (!await showNativeDialog({ title: '删除剪贴板记录', label: '确认删除这条历史记录？', confirmLabel: '删除', confirmOnly: true, kind: 'history-delete' })) return;
        await invoke('history.delete', { id });
        showToast('历史记录已删除。');
      }
      else {
        const result = await invoke('history.action', { id, action });
        if (action === 'translate' && result?.text) showToast(result.text);
      }
      await renderBoards();
      await refreshHistory();
    }
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = rows[selected];
      if (item) void pasteItem(item, event.shiftKey);
      return;
    }
    event.preventDefault();
    selected = Math.max(0, Math.min(rows.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
    renderRows();
    list.querySelector('.history-card[aria-selected="true"]')?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); hideWindow(); }
    if (document.activeElement === queryInput && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      selected = Math.max(0, Math.min(rows.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      renderRows();
      list.querySelector('.history-card[aria-selected="true"]')?.focus();
    }
    if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const item = rows[Number(event.key) - 1];
      if (item) void pasteItem(item, event.shiftKey);
    }
  });
  document.querySelectorAll('[data-action="window.hide"]').forEach(element => element.addEventListener('click', hideWindow));
  document.querySelectorAll('[data-window-command="minimize"], [data-window-command="maximize"]').forEach(element => {
    element.addEventListener('click', () => void invoke('window.control', {
      command: element.dataset.windowCommand,
    }));
  });
  document.querySelector('[data-action="history.clear"]').addEventListener('click', async () => {
    const cleared = await invoke('history.clear', {});
    if (!cleared) { showToast('已取消清理。'); return; }
    await refreshHistory();
    showToast('普通历史已清理。');
  });
  function showSettingsStatus(settings, success = false) {
    const status = $('#settings-status');
    const errors = settings?.shortcutErrors || {};
    const shortcutErrors = Object.values(errors).filter(Boolean);
    for (const key of ['history', 'launcher', 'stack', 'selection', 'article']) {
      const message = errors[key] || '';
      const field = $('#shortcut-error-' + key);
      field.textContent = message;
      field.hidden = !message;
      field.dataset.error = String(Boolean(message));
    }
    const messages = [];
    if (settings?.nativeError) messages.push(settings.nativeError);
    for (const key of ['history', 'launcher', 'stack', 'selection', 'article']) if (errors[key]) messages.push(key + '：' + errors[key]);
    if (success && messages.length === 0) messages.push('设置已保存。');
    status.textContent = messages.join(' ');
    status.hidden = messages.length === 0;
    status.dataset.error = String(Boolean(settings?.nativeError || shortcutErrors.length));
    if (settings?.nativeError) {
      $('#capture-state').textContent = '剪贴板助手不可用';
      $('#capture-state').dataset.active = 'false';
    } else if (settings) {
      $('#capture-state').textContent = settings.captureEnabled ? '正在记录' : '采集已关闭';
      $('#capture-state').dataset.active = String(Boolean(settings.captureEnabled));
    }
  }

  function applySettings(settings) {
    if (!settings) return;
    $('#capture-enabled').checked = Boolean(settings.captureEnabled);
    $('#auto-paste-enabled').checked = Boolean(settings.autoPaste);
    $('#selection-enabled').checked = Boolean(settings.selectionEnabled);
    $('#selection-copy-fallback').checked = Boolean(settings.selectionCopyFallback ?? settings.plainSelectionCopy);
    $('#tray-enabled').checked = Boolean(settings.trayEnabled);
    const excluded = settings.excludedProcesses ?? settings.ignoredProcesses;
    $('#excluded-processes').value = Array.isArray(excluded) ? excluded.join(', ') : '';
    $('#history-cap').value = String(settings.maxItems || 500);
    $('#image-cap').value = String(Math.max(16, Math.round((Number(settings.maxImageBytes) || 256 * 1024 * 1024) / 1024 / 1024)));
    const shortcuts = settings.shortcuts || {};
    $('#shortcut-history').value = shortcuts.history || 'Alt+V';
    $('#shortcut-launcher').value = shortcuts.launcher || 'Control+Alt+Space';
    $('#shortcut-stack').value = shortcuts.stack || 'Control+Alt+Shift+V';
    $('#shortcut-selection').value = shortcuts.selection || 'Control+Alt+Shift+T';
    $('#shortcut-article').value = shortcuts.article || 'Control+Alt+Shift+S';
    showSettingsStatus(settings);
  }

  $('[data-action="settings.save"]').onclick = async () => {
    const excludedProcesses = $('#excluded-processes').value.split(/[,，;；\s]+/).map(value => value.trim()).filter(Boolean);
    try {
      const settings = await invoke('settings.update', {
        captureEnabled: $('#capture-enabled').checked,
        autoPaste: $('#auto-paste-enabled').checked,
        selectionEnabled: $('#selection-enabled').checked,
        selectionCopyFallback: $('#selection-copy-fallback').checked,
        trayEnabled: $('#tray-enabled').checked,
        excludedProcesses,
        maxItems: Number($('#history-cap').value),
        maxImageBytes: Number($('#image-cap').value) * 1024 * 1024,
        shortcuts: {
          history: $('#shortcut-history').value.trim(),
          launcher: $('#shortcut-launcher').value.trim(),
          stack: $('#shortcut-stack').value.trim(),
          selection: $('#shortcut-selection').value.trim(),
          article: $('#shortcut-article').value.trim(),
        },
      });
      applySettings(settings);
      showSettingsStatus(settings, true);
      if (Object.values(settings?.shortcutErrors || {}).filter(Boolean).length === 0) showToast('设置已保存。');
      else showToast('已保存可用设置，冲突快捷键保持原值。', true);
    } catch { /* invoke already displays the concrete native or validation error. */ }
  };
  const settings = await invoke('settings.get', {});
  applySettings(settings);
  await renderBoards();
  await refreshHistory();
  queryInput.focus();
  desktop.onChanged?.(() => { void refreshHistory(); });
}

async function launcherPage() {
  const input = $('#launcher-search');
  const results = $('#launcher-results');
  let items = [];
  let selected = 0;
  let requestGeneration = 0;

  async function search() {
    const query = input.value.trim();
    const request = ++requestGeneration;
    const remote = await invoke('launcher.search', { query });
    if (request !== requestGeneration) return;
    items = Array.isArray(remote) ? remote : [];
    selected = 0;
    render();
  }

  function render() {
    results.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = button('', 'launcher.choose', { role: 'option', 'aria-selected': String(index === selected), 'data-command-id': item.id });
      row.className = 'launcher-result';
      const title = document.createElement('strong');
      title.textContent = item.label;
      const description = document.createElement('span');
      description.textContent = item.description || '';
      row.append(title, description);
      results.append(row);
    }
    if (items.length === 0) {
      const noResults = document.createElement('p');
      noResults.className = 'empty-inline';
      noResults.textContent = '没有匹配的命令或片段';
      results.append(noResults);
    }
  }

  async function runSelected() {
    const item = items[selected];
    if (!item) return;
    const result = await invoke('launcher.run', { commandId: item.id, query: input.value.trim() });
    if (item.id === 'calculator.copy') {
      showToast(result?.text ? '已复制 ' + result.text : '已复制计算结果。');
      return;
    }
  }

  input.addEventListener('input', () => void search());
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(0, Math.min(items.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void runSelected();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideWindow();
    }
  });
  results.addEventListener('click', event => {
    const target = event.target.closest('[data-command-id]');
    if (!target) return;
    selected = items.findIndex(item => item.id === target.dataset.commandId);
    void runSelected();
  });
  input.focus();
  await search();
}

async function selectionPage() {
  const preview = $('#selection-preview');
  const state = await invoke('selection.state', {});
  const text = String(state?.text || '');
  preview.textContent = text;
  if (!text) $('#selection-result').textContent = '没有检测到选中文本。请在其他应用选中文本后按划词快捷键。';
  document.querySelectorAll('[data-selection-action]').forEach(control => control.addEventListener('click', async () => {
    const action = control.dataset.selectionAction;
    const result = await invoke('selection.action', { action, selectionToken: state?.selectionToken });
    const output = $('#selection-result');
    if (action === 'count') output.textContent = Array.from(text).length + ' 个字符';
    else if (result?.text) output.textContent = result.text;
    else if (result?.message) output.textContent = result.message;
    else showToast('已发送到工作台。');
  }));
  $('[data-action="window.hide"]').addEventListener('click', hideWindow);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideWindow(); });
}

async function pinPage() {
  const image = $('#pin-image');
  const state = await invoke('pin.state', {});
  if (state?.imageUrl) image.src = state.imageUrl;
  $('#pin-opacity').value = String(Math.max(0.2, Math.min(1, Number(state?.opacity) || 1)));
  $('[data-pin-action="shrink"]').addEventListener('click', () => void invoke('pin.resize', { direction: 'shrink' }));
  $('[data-pin-action="grow"]').addEventListener('click', () => void invoke('pin.resize', { direction: 'grow' }));
  $('[data-pin-action="save"]').addEventListener('click', () => void invoke('pin.save', {}));
  $('[data-pin-action="close"]').addEventListener('click', hideWindow);
  $('#pin-opacity').addEventListener('input', event => void invoke('pin.opacity', { opacity: Number(event.currentTarget.value) }));
  image.addEventListener('dblclick', hideWindow);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideWindow(); });
  document.addEventListener('wheel', event => {
    if (event.ctrlKey) return;
    void invoke('pin.resize', { direction: event.deltaY < 0 ? 'grow' : 'shrink' });
  }, { passive: true });
}

if (!desktop?.invoke) {
  showToast('工作台尚未连接本地桌面服务。', true);
} else if (page === 'clipboard') {
  void clipboardPage().catch(() => {});
} else if (page === 'launcher') {
  void launcherPage().catch(() => {});
} else if (page === 'selection') {
  void selectionPage().catch(() => {});
} else if (page === 'pin') {
  void pinPage().catch(() => {});
}
