const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function setupClipboardPage(container, { api, notice = () => {} } = {}) {
  if (!container || !api?.invoke) throw new TypeError('剪贴页需要剪贴板接口。');
  container.classList.add('clipboard-workspace');
  container.innerHTML = `
    <header class="clipboard-workspace__head">
      <div><h1>剪贴板</h1><span data-cp-status role="status"></span></div>
      <label><span class="clipboard-sr-only">搜索剪贴板</span><input type="search" data-cp-search placeholder="搜索文字、链接或看板"></label>
      <button type="button" data-cp-refresh>刷新</button>
    </header>
    <div class="clipboard-workspace__filters">
      <nav data-cp-boards aria-label="剪贴板看板"></nav>
      <nav data-cp-types aria-label="按类型筛选">
        <button type="button" data-type="" aria-pressed="true">全部</button>
        <button type="button" data-type="text" aria-pressed="false">文本</button>
        <button type="button" data-type="link" aria-pressed="false">链接</button>
        <button type="button" data-type="image" aria-pressed="false">图片</button>
        <button type="button" data-type="files" aria-pressed="false">文件</button>
        <button type="button" data-type="color" aria-pressed="false">颜色</button>
      </nav>
    </div>
    <section class="clipboard-workspace__actions" aria-label="选中条目操作">
      <label><input type="checkbox" data-cp-select-visible> 选择当前列表</label>
      <span data-cp-selected-count>未选择条目</span>
      <button type="button" data-cp-copy-selected disabled>复制所选内容</button>
      <button type="button" data-cp-delete-selected disabled>删除所选</button>
      <button type="button" data-cp-create-board>新建看板</button>
    </section>
    <div class="clipboard-workspace__body">
      <section class="clipboard-workspace__list" data-cp-list aria-label="剪贴板历史" aria-live="polite"></section>
      <aside class="clipboard-workspace__detail" data-cp-detail aria-label="条目详情"><p>选择一条记录查看详情。</p></aside>
    </div>
    <dialog class="clipboard-workspace__delete" data-cp-delete-dialog aria-label="删除所选剪贴板记录">
      <form method="dialog">
        <h2>删除所选记录</h2>
        <p data-cp-delete-message></p>
        <footer><button value="cancel" autofocus>取消</button><button value="delete">删除</button></footer>
      </form>
    </dialog>`;

  const $ = selector => container.querySelector(selector);
  const selectedIds = new Set();
  const state = { query: '', type: '', boardId: '', rows: [], boards: [], detailId: '', searchToken: 0 };
  let searchTimer;
  let deleting = false;
  let deleteIds = [];

  async function invoke(operation, input = {}) {
    try { return await api.invoke(operation, input); }
    catch (error) { notice(error?.message || '剪贴板操作失败。', true); throw error; }
  }

  function preview(item) {
    return item.preview || item.text || item.url || (item.paths || []).join(' · ') || item.name || '没有可预览的内容';
  }

  function renderRows() {
    const list = $('[data-cp-list]');
    list.replaceChildren();
    if (!state.rows.length) {
      const empty = document.createElement('p');
      empty.className = 'clipboard-workspace__empty';
      empty.textContent = '没有匹配的剪贴板记录。';
      list.append(empty);
      updateSelection();
      return;
    }
    for (const item of state.rows) {
      const row = document.createElement('article');
      row.className = 'clipboard-workspace__row';
      row.dataset.itemId = item.id;
      row.setAttribute('aria-selected', String(state.detailId === item.id));
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedIds.has(item.id);
      checkbox.disabled = deleting;
      checkbox.setAttribute('aria-label', '选择 ' + preview(item).slice(0, 48));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(item.id); else selectedIds.delete(item.id);
        updateSelection();
      });
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'clipboard-workspace__open';
      const title = document.createElement('strong');
      title.textContent = ({ text: '文本', link: '链接', image: '图片', files: '文件', color: '颜色' })[item.type] || '富文本';
      const content = document.createElement('span'); content.textContent = preview(item);
      const meta = document.createElement('small');
      const stamp = item.updatedAt || item.createdAt;
      meta.textContent = [item.sourceName || item.sourceProcess || '来源未知', stamp ? new Date(stamp).toLocaleString() : ''].filter(Boolean).join(' · ');
      open.append(title, content, meta);
      open.addEventListener('click', () => void openDetail(item.id));
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
      copy.addEventListener('click', () => void copyOne(item.id));
      row.append(checkbox, open, copy);
      list.append(row);
    }
    updateSelection();
  }

  function updateSelection() {
    const count = selectedIds.size;
    $('[data-cp-selected-count]').textContent = count ? `已选择 ${count} 条` : '未选择条目';
    $('[data-cp-copy-selected]').disabled = count === 0 || deleting;
    $('[data-cp-delete-selected]').disabled = count === 0 || deleting;
    const selectVisible = $('[data-cp-select-visible]');
    selectVisible.disabled = deleting || !state.rows.length;
    const selectedVisible = state.rows.filter(row => selectedIds.has(row.id)).length;
    selectVisible.checked = selectedVisible > 0 && selectedVisible === state.rows.length;
    selectVisible.indeterminate = selectedVisible > 0 && !selectVisible.checked;
  }

  async function load({ keepSelection = true } = {}) {
    const token = ++state.searchToken;
    const result = await invoke('history.search', { query: state.query, type: state.type, boardId: state.boardId, limit: 150, offset: 0 });
    if (token !== state.searchToken) return;
    state.rows = Array.isArray(result) ? result : [];
    if (!keepSelection) selectedIds.clear();
    else for (const id of selectedIds) if (!state.rows.some(item => item.id === id)) selectedIds.delete(id);
    renderRows();
  }

  async function renderBoards() {
    state.boards = await invoke('boards.list');
    const nav = $('[data-cp-boards]'); nav.replaceChildren();
    const all = document.createElement('button'); all.type = 'button'; all.textContent = '全部看板'; all.disabled = deleting;
    all.setAttribute('aria-pressed', String(!state.boardId)); all.addEventListener('click', () => { state.boardId = ''; void renderBoards().then(() => load()); }); nav.append(all);
    for (const board of state.boards) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = board.name; button.disabled = deleting;
      button.setAttribute('aria-pressed', String(state.boardId === board.id));
      button.addEventListener('click', () => { state.boardId = board.id; void renderBoards().then(() => load()); }); nav.append(button);
    }
  }

  async function openDetail(id) {
    state.detailId = id;
    const item = await invoke('history.detail', { id });
    if (!item || state.detailId !== id) return;
    $('[data-cp-detail]').innerHTML = '';
    const detail = $('[data-cp-detail]'); detail.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = ({ text: '文本', link: '链接', image: '图片', files: '文件', color: '颜色' })[item.type] || '富文本';
    const body = document.createElement('pre'); body.textContent = item.text || (item.paths || []).join('\n') || item.url || item.preview || '';
    const actions = document.createElement('div'); actions.className = 'clipboard-workspace__detail-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.addEventListener('click', () => void copyOne(id));
    const note = document.createElement('button'); note.type = 'button'; note.textContent = '保存为笔记'; note.addEventListener('click', async () => { await invoke('history.action', { id, action: 'note' }); notice('已保存为笔记。'); });
    const translate = document.createElement('button'); translate.type = 'button'; translate.textContent = '翻译'; translate.addEventListener('click', async () => { const result = await invoke('history.action', { id, action: 'translate' }); if (result?.text) notice(result.text); });
    actions.append(copy, note, translate);
    detail.append(heading, body, actions);
    renderRows();
  }

  async function copyOne(id) {
    await invoke('history.copy', { id });
    notice('已复制到系统剪贴板。');
  }

  $('[data-cp-search]').addEventListener('input', event => {
    clearTimeout(searchTimer); state.query = event.currentTarget.value;
    searchTimer = setTimeout(() => void load(), 100);
  });
  $('[data-cp-types]').addEventListener('click', event => {
    const target = event.target.closest('[data-type]'); if (!target) return;
    state.type = target.dataset.type || '';
    $('[data-cp-types]').querySelectorAll('[data-type]').forEach(button => button.setAttribute('aria-pressed', String(button === target)));
    void load();
  });
  $('[data-cp-select-visible]').addEventListener('change', event => {
    for (const item of state.rows) event.currentTarget.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id);
    renderRows();
  });
  $('[data-cp-copy-selected]').addEventListener('click', async () => {
    const ids = state.rows.filter(item => selectedIds.has(item.id)).map(item => item.id);
    if (!ids.length) return;
    try {
      const result = await invoke('history.copy-batch', { ids });
      notice(result.type === 'files' ? `已复制 ${result.count} 个文件。` : `已合并复制 ${result.count} 条记录。`);
      selectedIds.clear();
      renderRows();
    } catch { /* The operation reports its error and preserves the selection. */ }
  });
  const deleteDialog = $('[data-cp-delete-dialog]');
  $('[data-cp-delete-selected]').addEventListener('click', () => {
    deleteIds = state.rows.filter(item => selectedIds.has(item.id)).map(item => item.id);
    if (!deleteIds.length || deleting) return;
    deleteDialog.returnValue = '';
    $('[data-cp-delete-message]').textContent = `将删除 ${deleteIds.length} 条剪贴板记录，并移除它们在看板中的关联。`;
    deleteDialog.showModal();
  });
  deleteDialog.addEventListener('close', async () => {
    if (deleteDialog.returnValue !== 'delete') return;
    deleting = true;
    clearTimeout(searchTimer);
    state.searchToken++;
    const controls = container.querySelectorAll('[data-cp-refresh], [data-cp-search], [data-cp-types] button, [data-cp-boards] button');
    controls.forEach(control => { control.disabled = true; });
    renderRows();
    const deleted = new Set();
    const failures = [];
    for (const id of deleteIds) {
      try {
        await api.invoke('history.delete', { id });
        deleted.add(id);
        selectedIds.delete(id);
      } catch (error) {
        failures.push(error?.message || '删除失败。');
      }
    }
    if (deleted.has(state.detailId)) {
      state.detailId = '';
      $('[data-cp-detail]').innerHTML = '<p>选择一条记录查看详情。</p>';
    }
    state.rows = state.rows.filter(item => !deleted.has(item.id));
    let refreshFailed = false;
    try { await renderBoards(); await load(); }
    catch { refreshFailed = true; }
    finally {
      deleting = false;
      controls.forEach(control => { control.disabled = false; });
      $('[data-cp-boards]').querySelectorAll('button').forEach(control => { control.disabled = false; });
      renderRows();
    }
    const message = `已删除 ${deleted.size} 条${failures.length ? `，${failures.length} 条失败。 ${failures[0]}` : '。'}`;
    $('[data-cp-status]').textContent = message;
    notice(refreshFailed ? `${message} 请刷新列表核对。` : message, Boolean(failures.length || refreshFailed));
    if (!$('[data-cp-delete-selected]').disabled) $('[data-cp-delete-selected]').focus();
    else $('[data-cp-refresh]').focus();
  });
  $('[data-cp-refresh]').addEventListener('click', () => void renderBoards().then(() => load()));
  $('[data-cp-create-board]').addEventListener('click', async () => {
    const name = window.prompt('看板名称');
    if (!name?.trim()) return;
    await invoke('boards.create', { name: name.trim() });
    await renderBoards(); notice('看板已创建。');
  });
  api.onChanged?.(() => { if (!deleting) void renderBoards().then(() => { if (!deleting) return load(); }).catch(() => {}); });
  void renderBoards().then(() => load()).catch(error => notice(error?.message || '剪贴板加载失败。', true));
  return { load, isDirty: () => false };
}
