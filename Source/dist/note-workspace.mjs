import { setMarkdownContent, handleMarkdownLink } from './markdown-renderer.mjs';

const draftsByContext = new Map();
const titleCharacters = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
let workspaceNumber = 0;
const archiveSignatures = new WeakMap();
const tabSignatures = new WeakMap();
const categories = [
  ['note', '笔记'], ['daily', '日报'], ['weekly', '周报'], ['reading', '阅读笔记'],
];

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function titleFromBody(body) {
  const firstLine = String(body).split(/\r?\n/).find(line => line.trim()) ?? '';
  const title = firstLine.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
  return Array.from(titleCharacters.segment(title), item => item.segment).slice(0, 10).join('') || '未命名笔记';
}

function parseTags(value) {
  return [...new Set(String(value).split(/[,，、;；\n]/).map(tag => tag.trim()).filter(Boolean))];
}

function draftKey(item, context, kind) {
  if (item && kind === 'note' && item.id) return `${context}\u0000${kind}\u0000${item.id}`;
  return item ? `${context}\u0000${kind}\u0000${item.path ?? item.name ?? item.id}` : `${context}\u0000${kind}\u0000draft-${crypto.randomUUID()}`;
}

export function mountNoteWorkspace(panel, options) {
  const {
    api, kind = 'note', fixedKind, file = null, currentPage = () => 1, pageCount = () => null, getWorkDate = () => new Date().toLocaleDateString('en-CA'),
    linkId = null, linkApi = null, onTranslate = null, onOpenFile = null, selectAnchor = null,
    addTemplate = null, showNotice = () => {}, contextId = '',
  } = options;
  if (!panel || (!api && !linkApi)) throw new Error('笔记工作区尚未连接。');
  const fileMode = Boolean(file?.id);
  const pdfMode = fileMode && (file.isPdf ?? /\.pdf$/i.test(file.name));
  const linkMode = Boolean(linkId && linkApi);
  const context = `${contextId || (linkMode ? `link:${linkId}` : fileMode ? `file:${file.id}` : fixedKind ? `fixed:${fixedKind}` : 'notes')}`;
  let session = draftsByContext.get(context);
  if (!session) {
    session = { category: fileMode ? 'reading' : fixedKind ?? kind, tabs: [], activeKey: null };
    draftsByContext.set(context, session);
  }
  let saving = false;
  let disposed = false;
  let loadToken = 0;
  let metadataSaved = false;
  let externalRefreshPending = true;
  let refreshingExternal = false;
  let refreshAgain = false;
  let previewTimer;
  let composing = false;
  let previewSource = null;
  let selectedReadingText = null;
  const safeKind = fixedKind ?? kind;
  const metadataTitleId = `nw-metadata-title-${++workspaceNumber}`;
  const titleForKind = value => categories.find(([key]) => key === value)?.[1] ?? '笔记';

  panel.classList.add('note-workspace');
  panel.innerHTML = `
    <header class="note-workspace__top">
      <div class="note-workspace__archive-head">
        <strong data-nw-category-title></strong>
        ${linkMode ? `<button type="button" data-nw-list-toggle aria-expanded="false" aria-controls="${metadataTitleId}-archive">笔记列表</button>` : ''}
        <button type="button" data-nw-new aria-label="新建笔记">＋</button>
      </div>
      <div class="note-workspace__tabs" data-nw-tabs role="tablist" aria-label="打开的笔记"></div>
    </header>
    <div class="note-workspace__layout">
      <aside class="note-workspace__archive" id="${metadataTitleId}-archive" data-nw-archive aria-label="笔记归档">
        <nav class="note-workspace__categories" data-nw-categories aria-label="笔记分类"></nav>
        <input class="note-workspace__search" data-nw-search type="search" aria-label="搜索归档" placeholder="搜索标题、正文或标签">
        <div class="note-workspace__archive-tools"><button type="button" data-nw-refresh>刷新文件夹</button></div>
        <div class="note-workspace__archive-list" data-nw-list></div>
      </aside>
      <section class="note-workspace__editor">
        <div class="note-workspace__editor-head"><span data-nw-title></span><span data-nw-status role="status"></span><div class="note-workspace__modes" role="group" aria-label="Markdown 显示方式"><button type="button" data-nw-mode="reading" aria-pressed="false">阅读</button><button type="button" data-nw-mode="preview" aria-pressed="false">实时预览</button><button type="button" data-nw-mode="source" aria-pressed="false">源码</button></div><button type="button" data-nw-save>保存　Ctrl+S</button></div>
        <section class="note-workspace__conflict" data-nw-conflict hidden role="alert">
          <span data-nw-conflict-message></span>
          <button type="button" data-nw-conflict-view>查看磁盘版本</button>
          <button type="button" data-nw-conflict-copy>另存为新笔记</button>
          <button type="button" data-nw-conflict-load>载入磁盘版本</button>
        </section>
        <div class="note-workspace__content" data-nw-content>
          <label class="note-workspace__body-label"><span class="note-workspace__sr-only">Markdown 正文</span><textarea data-nw-body placeholder="从这里开始写 Markdown" spellcheck="false"></textarea></label>
          <article class="note-workspace__preview markdown-content" data-nw-preview tabindex="0" aria-label="Markdown 阅读内容"></article>
        </div>
        <div class="note-workspace__editor-bottom"><span data-nw-location></span><button type="button" data-nw-translate>翻译选中文字</button></div>
      </section>
    </div>
    <dialog class="note-workspace__metadata" data-nw-metadata aria-labelledby="${metadataTitleId}">
      <form data-nw-metadata-form>
        <h2 id="${metadataTitleId}">保存笔记</h2>
        <label>归档日期<input name="date" type="date" required></label>
        <label>标签<input name="tags" placeholder="用逗号分隔多个标签"></label>
        <label data-nw-page-field hidden>对应页码<input name="page" type="number" min="1" step="1"></label>
        <p data-nw-metadata-message role="status"></p>
        <footer><button type="button" data-nw-cancel>取消</button><button type="submit">保存</button></footer>
      </form>
    </dialog>
    <dialog class="note-workspace__conflict-dialog" data-nw-conflict-dialog aria-labelledby="${metadataTitleId}-conflict-title">
      <h2 id="${metadataTitleId}-conflict-title">磁盘上的笔记版本</h2>
      <p data-nw-conflict-dialog-message></p>
      <pre data-nw-conflict-body></pre>
      <footer><button type="button" data-nw-conflict-dialog-close>关闭</button><button type="button" data-nw-conflict-dialog-copy>另存为新笔记</button><button type="button" data-nw-conflict-dialog-load>载入磁盘版本</button></footer>
    </dialog>`;

  const $ = selector => panel.querySelector(selector);
  const archive = $('[data-nw-list]');
  const body = $('[data-nw-body]');
  const tabs = $('[data-nw-tabs]');
  const saveButton = $('[data-nw-save]');
  const metadata = $('[data-nw-metadata]');
  const metadataForm = $('[data-nw-metadata-form]');
  const categoriesNav = $('[data-nw-categories]');
  const listToggle = $('[data-nw-list-toggle]');
  const archivePanel = $('[data-nw-archive]');
  const search = $('[data-nw-search]');
  const categoryTitle = $('[data-nw-category-title]');
  const pageField = $('[data-nw-page-field]');
  const pageInput = metadataForm.elements.page;
  const conflictBanner = $('[data-nw-conflict]');
  const conflictDialog = $('[data-nw-conflict-dialog]');
  const content = $('[data-nw-content]');
  const preview = $('[data-nw-preview]');
  const bodyLabel = body.closest('label');
  const modes = [...panel.querySelectorAll('[data-nw-mode]')];
  const sharedTabs = session.tabs;
  let reconciledNotes = null;
  let selectedFolderPath = '';
  let pendingMove = null;
  const expandedFolders = new Set();

  function setArchiveOpen(expanded) {
    listToggle.setAttribute('aria-expanded', String(expanded));
    archivePanel.hidden = !expanded;
  }

  if (fileMode) {
    archivePanel.hidden = true;
    panel.classList.add('note-workspace--reader');
    categoryTitle.textContent = file.name;
  }
  if (pdfMode) {
    pageField.hidden = false;
    pageInput.max = pageCount() ?? '';
  }
  if (linkMode) {
    categoryTitle.textContent = '链接笔记';
    panel.classList.add('note-workspace--link-reader');
    setArchiveOpen(false);
    listToggle.onclick = () => setArchiveOpen(archivePanel.hidden);
  }
  if (fixedKind) $('[data-nw-category-title]').textContent = titleForKind(fixedKind);
  if (fixedKind || fileMode || linkMode) categoriesNav.hidden = true;

  function getActive() { return sharedTabs.find(tab => tab.key === session.activeKey) ?? null; }

  function expandFolderPath(folderPath, includeSelf = true) {
    const parts = String(folderPath ?? '').split('/').filter(Boolean);
    const limit = includeSelf ? parts.length : Math.max(0, parts.length - 1);
    for (let index = 1; index <= limit; index++) expandedFolders.add(parts.slice(0, index).join('/'));
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    if (disposed || previewSource === body.value) return;
    previewSource = body.value;
    const top = preview.scrollTop;
    setMarkdownContent(preview, body.value);
    if (!body.value.trim()) {
      const empty = make('p', '输入 Markdown 后，这里会同步显示阅读样式。', 'note-workspace__preview-empty');
      preview.replaceChildren(empty);
    }
    preview.scrollTop = top;
  }

  function updateMode(tab, { focus = false } = {}) {
    const mode = tab.mode ?? (tab.id || tab.name ? 'reading' : 'preview');
    content.dataset.mode = mode;
    bodyLabel.hidden = mode === 'reading';
    preview.hidden = mode === 'source';
    for (const button of modes) button.setAttribute('aria-pressed', String(button.dataset.nwMode === mode));
    if (mode !== 'source') renderPreview();
    if (focus) (mode === 'reading' ? preview : body).focus({ preventScroll: true });
  }

  function syncDraft() {
    const current = getActive();
    if (!current) return;
    if (current.body !== body.value) {
      current.body = body.value;
      current.dirty = true;
    }
  }

  function activate(tab) {
    syncDraft();
    selectedReadingText = '';
    session.activeKey = tab.key;
    updateEditor(tab);
    renderConflict(tab);
    renderTabs();
  }

  function updateEditor(tab) {
    const changed = body.value !== tab.body;
    body.value = tab.body;
    updateMode(tab);
    if (changed) preview.scrollTop = body.scrollTop = 0;
    $('[data-nw-title]').textContent = tab.dirty ? titleFromBody(tab.body) : tab.title || titleFromBody(tab.body);
    $('[data-nw-status]').textContent = tab.conflict ? '外部版本冲突' : tab.dirty ? '未保存' : '';
    $('[data-nw-location]').textContent = pdfMode ? `第 ${tab.page || currentPage()} 页` : linkMode ? '链接笔记' : tab.fileId ? '阅读笔记' : titleForKind(tab.kind);
    saveButton.disabled = !tab.body.trim() || saving;
  }

  function renderTabs() {
    const signature = JSON.stringify([
      session.activeKey,
      ...sharedTabs.map(tab => [tab.key, tab.dirty ? titleFromBody(tab.body) : tab.title || titleFromBody(tab.body), tab.dirty, tab.conflict?.type ?? '']),
    ]);
    if (tabSignatures.get(tabs) === signature) return;
    tabSignatures.set(tabs, signature);
    tabs.replaceChildren();
    for (const tab of sharedTabs) {
      const item = make('div', undefined, 'note-workspace__tab');
      item.setAttribute('role', 'presentation');
      const label = tab.dirty ? titleFromBody(tab.body) : tab.title || titleFromBody(tab.body);
      const button = make('button', label, 'note-workspace__tab-title');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.key === session.activeKey));
      button.classList.toggle('note-workspace__tab-title--conflict', Boolean(tab.conflict));
      button.title = label;
      button.onclick = () => activate(tab);
      const close = make('button', '×', 'note-workspace__tab-close');
      close.type = 'button';
      close.setAttribute('aria-label', `关闭${button.title}`);
      close.onclick = event => {
        event.stopPropagation();
        syncDraft();
        if (tab.dirty && !confirm('这条笔记尚未保存，关闭后会丢弃当前草稿。继续吗？')) return;
        const index = sharedTabs.indexOf(tab);
        sharedTabs.splice(index, 1);
        if (session.activeKey === tab.key) {
          const next = sharedTabs[Math.max(0, index - 1)];
          session.activeKey = null;
          if (next) activate(next);
          else createDraft();
        } else renderTabs();
      };
      item.append(button, close);
      tabs.append(item);
    }
    const add = make('button', '＋', 'note-workspace__tab-add');
    add.type = 'button';
    add.setAttribute('aria-label', '新建笔记标签');
    add.disabled = session.category === 'reading' && !fileMode;
    add.onclick = createDraft;
    tabs.append(add);
  }

  function renderConflict(tab = getActive()) {
    const conflict = tab?.conflict;
    conflictBanner.hidden = !conflict;
    $('[data-nw-conflict-message]').textContent = conflict
      ? conflict.type === 'deleted' ? '此笔记已从 Notes 文件夹移走或删除，当前内容仍保留在标签中。'
        : '此笔记已在 Notes 文件夹中更新，当前未保存内容仍保留在标签中。'
      : '';
    $('[data-nw-conflict-view]').disabled = conflict?.type === 'deleted';
    $('[data-nw-conflict-load]').disabled = conflict?.type === 'deleted';
    if (tab && session.activeKey === tab.key && conflict) $('[data-nw-status]').textContent = '外部版本冲突';
  }

  function createDraft(focus = true) {
    const selectedKind = linkMode ? 'link-note' : pdfMode ? 'note' : session.category === 'reading' ? 'note' : safeKind === 'note' ? session.category : safeKind;
    const tab = {
      key: draftKey(null, context, selectedKind), id: null, name: null, kind: selectedKind,
      title: '', body: '', date: '', tags: [], page: pdfMode ? currentPage() : null,
      fileId: fileMode ? file.id : null, folderPath: selectedFolderPath, path: null, expectedContentHash: null, dirty: false,
      mode: 'preview',
    };
    sharedTabs.push(tab);
    expandFolderPath(tab.folderPath);
    activate(tab);
    if (focus) body.focus();
    return tab;
  }

  function itemToTab(item, itemKind = linkMode ? 'link-note' : safeKind) {
    if (linkMode) itemKind = 'link-note';
    const key = draftKey(item, context, itemKind);
    const prior = sharedTabs.find(tab => tab.key === key);
    if (prior) return prior;
    const tab = {
      key, id: item.id, name: item.name ?? null, path: item.path ?? item.name ?? null, folderPath: item.folderPath ?? '', kind: itemKind,
      title: item.title ?? '', body: item.body ?? '', date: item.date ?? '', tags: item.tags ?? [],
      fileId: item.fileId ?? null, page: item.page ?? null,
      expectedContentHash: item.expectedContentHash ?? item.contentHash ?? null, dirty: false,
      externalMarkdown: item.externalMarkdown === true,
    };
    sharedTabs.push(tab);
    return tab;
  }

  function renderCategories() {
    categoriesNav.replaceChildren();
    if (safeKind === 'memo' || fileMode || linkMode) return;
    for (const [value, label] of categories) {
      const button = make('button', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(session.category === value));
      button.onclick = () => {
        session.category = value;
        selectedFolderPath = '';
        for (const item of categoriesNav.children) item.setAttribute('aria-pressed', String(item === button));
        categoryTitle.textContent = label;
        renderTabs();
        search.value = '';
        void load();
      };
      categoriesNav.append(button);
    }
    categoryTitle.textContent = titleForKind(session.category);
    $('[data-nw-new]').disabled = session.category === 'reading' && !fileMode;
  }

  function archiveLabel(item) {
    const heading = item.title || titleFromBody(item.body || '');
    const entry = make('article', undefined, 'note-workspace__archive-item');
    const openButton = make('button', undefined, 'note-workspace__archive-open');
    openButton.type = 'button';
    openButton.append(make('strong', heading), make('small', `${item.date || ''}${item.page ? ` · 第 ${item.page} 页` : ''}`));
    if (item.folderPath) openButton.append(make('small', item.folderPath));
    if (item.tags?.length) openButton.append(make('small', item.tags.join(' · ')));
    openButton.onclick = async () => {
      const itemKind = linkMode ? 'link-note' : item.kind || safeKind;
      try {
        activate(itemToTab(item, itemKind));
        if (linkMode) {
          setArchiveOpen(false);
          (content.dataset.mode === 'reading' ? preview : body).focus({ preventScroll: true });
        }
      } catch (error) { showNotice(error.message || '笔记读取失败。', true); }
    };
    entry.append(openButton);
    entry.addEventListener('contextmenu', event => {
      if (fileMode || session.category === 'reading') return;
      event.preventDefault();
      void showArchiveMenu(event.clientX, event.clientY, item.folderPath ?? '', item);
    });
    if (item.fileId && onOpenFile) {
      const source = make('div', undefined, 'note-workspace__archive-source');
      const button = make('button', '打开来源文件');
      button.type = 'button';
      button.dataset.nwOpenSource = '';
      button.onclick = () => void Promise.resolve(onOpenFile(item.fileId, item.page)).catch(error => showNotice(error.message, true));
      source.append(button);
      entry.append(source);
    }
    return entry;
  }

  function folderScope() {
    if (linkMode) return 'link-notes';
    return ({ note: 'notes', memo: 'memos', daily: 'daily', weekly: 'weekly' })[fixedKind ?? session.category] ?? 'notes';
  }

  async function showArchiveMenu(x, y, parentPath = selectedFolderPath, item = null) {
    let folders = [];
    try { if (item) folders = await api.listFolders({ scope: folderScope(), linkId: linkMode ? linkId : undefined }); }
    catch (error) { showNotice(error.message || '文件夹读取失败。', true); return; }
    const choice = await folderDialog({ title: '笔记列表', actions: item ? ['新建笔记', '新建文件夹', '移动到'] : ['新建笔记', '新建文件夹'], folders });
    if (!choice) return;
    const scope = folderScope();
    try {
      if (choice.action === '新建笔记') {
        selectedFolderPath = parentPath;
        const tab = createDraft();
        tab.folderPath = parentPath;
      } else if (choice.action === '新建文件夹') {
        if (!choice.name?.trim()) { showNotice('文件夹名称不能为空。', true); return; }
        await api.createFolder({ scope, linkId: linkMode ? linkId : undefined, parentPath, name: choice.name.trim() });
        selectedFolderPath = [parentPath, choice.name.trim()].filter(Boolean).join('/');
        expandFolderPath(selectedFolderPath);
        await load({ reconcile: true });
        showNotice('文件夹已创建');
      } else if (choice.action === '移动到' && item) {
        const destination = choice.destination;
        const tab = sharedTabs.find(value => value.id === item.id && (linkMode ? value.path === (item.path ?? item.name) : true));
        if (tab?.dirty) {
          if (!confirm('笔记有未保存内容。保存后移动？')) return;
          expandFolderPath(destination);
          pendingMove = { scope, linkId: linkMode ? linkId : undefined, item, destination, tab };
          activate(tab);
          if (!requestSave()) pendingMove = null;
          return;
        }
        await moveSavedRecord({ scope, linkId: linkMode ? linkId : undefined, item, destination, tab });
      }
    } catch (error) { showNotice(error.message || '文件夹操作失败。', true); }
  }

  async function moveSavedRecord({ scope, linkId: moveLinkId, item, destination, tab, saved = null }) {
    const sourcePath = saved?.path ?? tab?.path ?? item.path ?? item.name;
    const moved = await api.moveRecord({
      scope, linkId: moveLinkId, relativePath: sourcePath,
      destination: destination.trim(), expectedContentHash: saved?.contentHash ?? saved?.expectedContentHash ?? tab?.expectedContentHash ?? item.expectedContentHash ?? item.contentHash,
    });
    if (tab) {
      const movedPath = moved.relativePath ?? sourcePath;
      tab.path = movedPath;
      tab.name = movedPath.split(/[\\/]/).at(-1);
      tab.folderPath = destination.trim();
      expandFolderPath(destination);
      tab.id = moved.id ?? tab.id;
      tab.relativePath = moved.relativePath ?? tab.relativePath;
      tab.expectedContentHash = moved.contentHash ?? tab.expectedContentHash;
      tab.dirty = false;
      tab.conflict = null;
      if (linkMode) {
        const nextKey = draftKey({ path: movedPath }, context, tab.kind);
        if (session.activeKey === tab.key) session.activeKey = nextKey;
        tab.key = nextKey;
      }
      renderTabs();
    }
    reconciledNotes = null;
    await load({ reconcile: true });
    showNotice('已移动到文件夹');
    return moved;
  }

  function folderDialog({ title, actions, folders = [] }) {
    return new Promise(resolve => {
      const dialog = make('dialog', undefined, 'note-workspace__folder-dialog');
      const form = document.createElement('form');
      form.method = 'dialog';
      form.append(make('h2', title));
      const actionSelect = document.createElement('select');
      for (const action of actions) { const option = document.createElement('option'); option.value = action; option.textContent = action; actionSelect.append(option); }
      form.append(actionSelect);
      const name = document.createElement('input'); name.placeholder = '文件夹名称'; name.autocomplete = 'off'; name.hidden = !actions.includes('新建文件夹');
      const destination = document.createElement('select');
      const rootOption = document.createElement('option'); rootOption.value = ''; rootOption.textContent = '根目录'; destination.append(rootOption);
      for (const folderPath of folders) { const option = document.createElement('option'); option.value = folderPath; option.textContent = folderPath; destination.append(option); }
      destination.hidden = !actions.includes('移动到');
      form.append(name, destination);
      const footer = document.createElement('footer');
      const cancel = make('button', '取消'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
      const submit = make('button', '确定'); submit.type = 'submit'; footer.append(cancel, submit); form.append(footer); dialog.append(form); panel.append(dialog);
      actionSelect.onchange = () => { name.hidden = actionSelect.value !== '新建文件夹'; destination.hidden = actionSelect.value !== '移动到'; };
      actionSelect.dispatchEvent(new Event('change'));
      dialog.addEventListener('close', () => { resolve(dialog.returnValue ? { action: dialog.returnValue, name: name.value, destination: destination.value } : null); dialog.remove(); }, { once: true });
      form.onsubmit = event => { event.preventDefault(); dialog.returnValue = actionSelect.value; dialog.close(); };
      dialog.showModal();
      if (!name.hidden) name.focus();
    });
  }

  function isTrackedNote(tab) {
    const trackedKind = fileMode || session.category === 'reading' ? 'note' : fixedKind ?? session.category;
    return !linkMode && tab.kind === trackedKind && (!fileMode || tab.fileId === file.id);
  }

  function adoptDiskIdentity(tab, disk) {
    const key = draftKey(disk, context, tab.kind);
    if (session.activeKey === tab.key) session.activeKey = key;
    tab.key = key;
    tab.id = disk.id;
    tab.name = disk.name ?? null;
    tab.path = disk.path ?? disk.name ?? null;
    tab.folderPath = disk.folderPath ?? '';
  }

  async function reconcileExternalLinkNotes() {
    const result = await linkApi.listLinkNotes(linkId);
    if (disposed) return;
    syncDraft();
    for (const tab of sharedTabs.filter(value => value.kind === 'link-note' && (value.path || value.name))) {
      let disk = null;
      try { disk = await linkApi.getLinkNote(linkId, tab.path ?? tab.name); }
      catch (error) {
        if (/ENOENT|找不到|无效|已经移走/.test(error.message || '')) {
          for (const fileEntry of result.files) {
            const candidate = await linkApi.getLinkNote(linkId, fileEntry.path ?? fileEntry.name).catch(() => null);
            if (candidate?.id === tab.id) { disk = candidate; break; }
          }
          if (!disk) tab.conflict = { type: 'deleted' };
        } else throw error;
      }
      if (!disk) continue;
      if ((tab.expectedContentHash ?? null) === (disk.expectedContentHash ?? null)) {
        adoptDiskIdentity(tab, disk);
        tab.conflict = null;
        continue;
      }
      if (tab.dirty) {
        tab.conflict = { type: 'updated', disk };
        continue;
      }
      adoptDiskIdentity(tab, disk);
      Object.assign(tab, {
        title: disk.title ?? '', body: disk.body ?? '', date: disk.date ?? '', tags: disk.tags ?? [],
        expectedContentHash: disk.expectedContentHash ?? null, dirty: false, conflict: null,
      });
      if (session.activeKey === tab.key) updateEditor(tab);
    }
    renderTabs();
    renderConflict();
    return result;
  }

  async function reconcileExternalNotes() {
    const activeKind = fileMode || session.category === 'reading' ? 'note' : fixedKind ?? session.category;
    const allNotes = await api.listNotes(session.category === 'reading' && !fileMode ? {} : { kind: activeKind });
    if (disposed) return;
    syncDraft();
    if (metadata.open) preserveMetadataDraft();
    const notes = allNotes.filter(item => item.kind === activeKind);
    for (const tab of sharedTabs.filter(isTrackedNote)) {
      if (!tab.id && !tab.name) continue;
      const disk = notes.find(item => item.id === tab.id) ??
        (tab.path ? notes.find(item => item.path === tab.path) : notes.find(item => item.name && item.name === tab.name));
      if (!disk) {
        tab.conflict = { type: 'deleted' };
        continue;
      }
      if (tab.expectedContentHash === disk.contentHash) {
        adoptDiskIdentity(tab, disk);
        if (tab.conflict) tab.conflict = null;
        continue;
      }
      if (tab.dirty) {
        tab.conflict = { type: 'updated', disk };
        continue;
      }
      adoptDiskIdentity(tab, disk);
      Object.assign(tab, {
        title: disk.title ?? '', body: disk.body ?? '',
        date: disk.date ?? '', tags: disk.tags ?? [], fileId: disk.fileId ?? null,
        page: disk.page ?? null, expectedContentHash: disk.contentHash ?? null,
        externalMarkdown: disk.externalMarkdown === true, conflict: null,
      });
      if (session.activeKey === tab.key) updateEditor(tab);
    }
    renderTabs();
    renderConflict();
    reconciledNotes = allNotes;
    return allNotes;
  }

  async function load({ reconcile = false } = {}) {
    if (reconcile) externalRefreshPending = true;
    let refreshSucceeded = true;
    if (externalRefreshPending && !refreshingExternal && !saving) {
      refreshingExternal = true;
      try {
        if (linkMode) await reconcileExternalLinkNotes();
        else await reconcileExternalNotes();
        externalRefreshPending = false;
      } catch (error) {
        refreshSucceeded = false;
        reconciledNotes = null;
        showNotice(error.message || 'Notes 文件夹刷新失败。', true);
      } finally {
        refreshingExternal = false;
        if (refreshAgain) {
          refreshAgain = false;
          void load({ reconcile: true });
        }
      }
    } else if (refreshingExternal) refreshAgain = true;
    const token = ++loadToken;
    try {
      let items;
      if (linkMode) {
        const result = await linkApi.listLinkNotes(linkId);
        archive.dataset.folders = JSON.stringify(result.folders ?? []);
        const entries = await Promise.allSettled(result.files.map(item => linkApi.getLinkNote(linkId, item.path ?? item.name)));
        items = entries.flatMap((entry, index) => entry.status === 'fulfilled' ? [entry.value] : [{ name: result.files[index].name, error: entry.reason?.message }]);
      } else {
        try { archive.dataset.folders = JSON.stringify(await api.listFolders({ scope: folderScope() })); } catch { archive.dataset.folders = '[]'; }
        const query = search.value;
        const selected = (session.category === 'reading' && fileMode && reconciledNotes) ||
          (session.category === 'note' && reconciledNotes)
          ? reconciledNotes.filter(item => item.kind === 'note' || session.category === 'reading')
          : session.category === 'reading' ? await api.listNotes({ query })
          : await api.listNotes({ kind: fixedKind ?? session.category, query, fileId: fileMode ? file.id : undefined });
        const matches = item => !query || [item.title, item.body, item.tags].map(value =>
          String(Array.isArray(value) ? value.join(' ') : value ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
        ).some(value => value.includes(query.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()));
        items = session.category === 'reading'
          ? selected.filter(item => item.fileId && (!fileMode || item.fileId === file.id) && matches(item))
          : selected.filter(item => !item.fileId && matches(item));
      }
      if (disposed || token !== loadToken) return;
      const signature = JSON.stringify([archive.dataset.folders, selectedFolderPath, [...expandedFolders].sort(), !items.length && Boolean(search.value), items.map(item => [item.id, item.path, item.name, item.folderPath, item.title, item.date, item.page, item.tags, item.contentHash, item.error])]);
      if (archiveSignatures.get(archive) === signature) return;
      archiveSignatures.set(archive, signature);
      archive.replaceChildren();
      const folderPaths = JSON.parse(archive.dataset.folders || '[]');
      const renderRecords = (parentPath, depth = 0) => {
        for (const item of items.filter(value => (value.folderPath ?? '') === parentPath)) {
          if (item.error) archive.append(make('p', `${item.name} · ${item.error}`, 'note-workspace__error'));
          else {
            const entry = archiveLabel(item);
            if (depth) entry.style.marginInlineStart = `${depth * 12}px`;
            archive.append(entry);
          }
        }
      };
      const renderFolders = (parentPath = '', depth = 0) => {
        for (const folderPath of folderPaths.filter(value => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '') === parentPath)) {
          const name = folderPath.slice(parentPath ? parentPath.length + 1 : 0);
          const row = make('div', undefined, 'note-workspace__folder-row');
          row.style.paddingInlineStart = `${depth * 12}px`;
          const toggle = make('button', expandedFolders.has(folderPath) ? '▾' : '▸', 'note-workspace__folder-toggle');
          toggle.type = 'button'; toggle.onclick = () => { expandedFolders.has(folderPath) ? expandedFolders.delete(folderPath) : expandedFolders.add(folderPath); void load(); };
          const folder = make('button', name, 'note-workspace__folder');
          folder.type = 'button'; folder.setAttribute('aria-current', String(selectedFolderPath === folderPath));
          folder.onclick = () => { selectedFolderPath = folderPath; expandFolderPath(folderPath); search.value = ''; void load(); };
          folder.oncontextmenu = event => { event.preventDefault(); void showArchiveMenu(event.clientX, event.clientY, folderPath); };
          row.append(toggle, folder); archive.append(row);
          if (expandedFolders.has(folderPath)) {
            renderRecords(folderPath, depth + 1);
            renderFolders(folderPath, depth + 1);
          }
        }
      };
      if (search.value) {
        if (!items.length) archive.append(make('p', '没有找到匹配的笔记。', 'note-workspace__empty'));
        else for (const item of items) archive.append(archiveLabel(item));
      } else {
        renderFolders();
        renderRecords('');
        if (!items.length && !folderPaths.length) archive.append(make('p', '这里还没有笔记。', 'note-workspace__empty'));
      }
    } catch (error) {
      if (!disposed && token === loadToken) {
        archiveSignatures.delete(archive);
        archive.replaceChildren(make('p', error.message || '笔记读取失败。', 'note-workspace__error'));
      }
      return false;
    }
    return refreshSucceeded;
  }

  async function notifyExternalChange() {
    externalRefreshPending = true;
    if (!panel.closest('[hidden]')) return load({ reconcile: true });
  }

  async function getLatestDiskVersion(tab) {
    if (linkMode) {
      try { return await linkApi.getLinkNote(linkId, tab.path ?? tab.name); }
      catch { return null; }
    }
    const items = await api.listNotes({ kind: tab.kind ?? 'note' });
    return items.find(item => item.id === tab.id) ??
      (tab.path ? items.find(item => item.path === tab.path) : items.find(item => item.name && item.name === tab.name)) ?? null;
  }

  async function viewDiskVersion() {
    const tab = getActive();
    if (!tab?.conflict) return;
    try {
      const disk = await getLatestDiskVersion(tab);
      if (!disk) {
        tab.conflict = { type: 'deleted' };
        renderConflict(tab);
        return;
      }
      tab.conflict = { type: 'updated', disk };
      $('[data-nw-conflict-dialog-message]').textContent = `${disk.name || disk.title} · 磁盘版本`;
      $('[data-nw-conflict-body]').textContent = disk.body ?? '';
      conflictDialog.showModal();
    } catch (error) { showNotice(error.message || '磁盘版本读取失败。', true); }
  }

  async function loadDiskVersion() {
    const tab = getActive();
    if (!tab?.conflict || tab.conflict.type === 'deleted') return;
    if ((tab.dirty || tab.body !== body.value) && !confirm('载入磁盘版本会放弃当前未保存修改，是否继续？')) return;
    const disk = await getLatestDiskVersion(tab);
    if (!disk) {
      tab.conflict = { type: 'deleted' };
      renderConflict(tab);
      return;
    }
    adoptDiskIdentity(tab, disk);
    Object.assign(tab, {
      title: disk.title ?? '', body: disk.body ?? '',
      date: disk.date ?? '', tags: disk.tags ?? [], fileId: disk.fileId ?? null,
      page: disk.page ?? null, expectedContentHash: disk.expectedContentHash ?? disk.contentHash ?? null,
      externalMarkdown: disk.externalMarkdown === true, dirty: false, conflict: null,
    });
    body.value = tab.body;
    activate(tab);
    conflictDialog.close();
    showNotice('已载入磁盘版本');
  }

  async function saveConflictAsNew() {
    const tab = getActive();
    if (!tab?.conflict) return;
    syncDraft();
    if (metadata.open) { preserveMetadataDraft(); metadata.close(); }
    try {
      const saved = await saveTab(tab, { date: tab.date || getWorkDate(), tags: tab.tags }, { asNew: true });
      conflictDialog.close();
      showNotice('已另存为新笔记');
      return saved;
    } catch (error) { showNotice(error.message || '另存为新笔记失败。', true); }
  }

  function requestSave() {
    if (disposed || saving || metadata.open) return false;
    syncDraft();
    const tab = getActive();
    if (!tab?.body.trim()) {
      $('[data-nw-status]').textContent = '请先填写正文。';
      return false;
    }
    metadataForm.elements.date.value = tab.date || getWorkDate();
    metadataForm.elements.tags.value = tab.tags.join('，');
    if (pdfMode) {
      pageInput.value = tab.page || currentPage();
      pageInput.max = pageCount() ?? '';
    }
    $('[data-nw-metadata-message]').textContent = '';
    metadataSaved = false;
    metadata.showModal();
    return true;
  }

  async function saveTab(tab, values = {}, { asNew = false } = {}) {
    if (saving) throw new Error('笔记正在保存，请稍后重试。');
    if (!tab?.body.trim()) throw new Error('请先填写正文。');
    const date = values.date ?? (tab.date || getWorkDate());
    const tags = values.tags ?? tab.tags;
    const page = pdfMode ? Number(values.page ?? tab.page ?? currentPage()) : (tab.page ?? null);
    if (!date || (pdfMode && (!Number.isInteger(page) || page < 1 || (pageCount() && page > pageCount())))) {
      throw new Error(pdfMode ? '请填写有效日期和页码。' : '请填写有效日期。');
    }
    saving = true;
    const submit = metadataForm.querySelector('[type=submit]');
    if (submit) submit.disabled = true;
    try {
      const input = {
        id: asNew ? undefined : tab.id, name: asNew ? undefined : tab.name, path: asNew ? undefined : tab.path, folderPath: tab.id && !asNew ? undefined : (tab.folderPath ?? ''),
        title: tab.externalMarkdown && tab.title ? tab.title : titleFromBody(tab.body), body: tab.body, tags, date,
        fileId: tab.fileId ?? file?.id ?? null, page,
        kind: tab.kind === 'link-note' ? undefined : tab.kind,
        expectedContentHash: asNew ? undefined : tab.expectedContentHash,
        linkId: linkMode ? linkId : undefined,
      };
      const saved = linkMode ? await linkApi.saveLinkNote(input) : await api.saveNote(input);
      const nextKey = draftKey(saved, context, tab.kind);
      const wasActive = session.activeKey === tab.key;
      if (wasActive) syncDraft();
      const editedWhileSaving = tab.body !== input.body;
      Object.assign(tab, {
        key: nextKey, id: saved.id, name: saved.name ?? null, path: saved.path ?? saved.name ?? null, folderPath: saved.folderPath ?? tab.folderPath ?? '', title: saved.title || input.title,
        date: saved.date || date, tags: saved.tags || tags, page: saved.page ?? page,
        expectedContentHash: saved.expectedContentHash ?? saved.contentHash ?? null, dirty: editedWhileSaving,
        conflict: null, externalMarkdown: false,
      });
      if (wasActive) {
        session.activeKey = tab.key;
        $('[data-nw-status]').textContent = editedWhileSaving ? '有未保存的修改' : '已保存';
        metadataSaved = true;
        metadata.close();
        activate(tab);
        showNotice('笔记已保存');
      }
      reconciledNotes = null;
      return saved;
    } catch (error) {
      if (/其他位置修改|笔记已经不存在/.test(error.message || '')) {
        tab.dirty = true;
        tab.conflict = { type: /已经不存在/.test(error.message || '') ? 'deleted' : 'updated' };
        externalRefreshPending = true;
        reconciledNotes = null;
        renderTabs();
        if (session.activeKey === tab.key) renderConflict(tab);
      }
      throw error;
    } finally {
      saving = false;
      if (submit) submit.disabled = false;
      if (!disposed) saveButton.disabled = !getActive()?.body.trim();
      if (!disposed) void load();
    }
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const tab = getActive();
    try {
      const saved = await saveTab(tab, {
        date: metadataForm.elements.date.value,
        tags: parseTags(metadataForm.elements.tags.value),
        page: pdfMode ? Number(pageInput.value) : getActive()?.page,
      });
      if (pendingMove?.tab === tab) {
        const move = pendingMove;
        pendingMove = null;
        try { await moveSavedRecord({ ...move, tab, saved }); }
        catch (error) { showNotice(`笔记已保存，但移动失败：${error.message || '请重试。'}`, true); return; }
      }
    } catch (error) {
      if (/其他位置修改|笔记已经不存在/.test(error.message || '')) {
        tab.dirty = true;
        tab.conflict = { type: /已经不存在/.test(error.message || '') ? 'deleted' : 'updated' };
        preserveMetadataDraft();
        metadata.close();
        $('[data-nw-status]').textContent = tab.conflict.type === 'deleted' ? '原文件已移除' : '外部版本冲突';
        renderConflict(tab);
        renderTabs();
        if (tab.conflict.type === 'updated') void viewDiskVersion();
      }
      $('[data-nw-metadata-message]').textContent = error.message || '保存失败，请重试。';
    }
  }

  $('[data-nw-new]').onclick = () => createDraft();
  archive.addEventListener('contextmenu', event => {
    if (event.target.closest('.note-workspace__archive-item,.note-workspace__folder') || fileMode || session.category === 'reading') return;
    event.preventDefault();
    void showArchiveMenu(event.clientX, event.clientY, '');
  });
  $('[data-nw-save]').onclick = requestSave;
  $('[data-nw-refresh]').onclick = async () => {
    if (await load({ reconcile: true })) showNotice('Notes 文件夹已刷新');
  };
  $('[data-nw-conflict-view]').onclick = () => void viewDiskVersion();
  $('[data-nw-conflict-copy]').onclick = () => void saveConflictAsNew();
  $('[data-nw-conflict-load]').onclick = () => void loadDiskVersion().catch(error => showNotice(error.message, true));
  $('[data-nw-conflict-dialog-close]').onclick = () => conflictDialog.close();
  $('[data-nw-conflict-dialog-copy]').onclick = () => void saveConflictAsNew();
  $('[data-nw-conflict-dialog-load]').onclick = () => void loadDiskVersion().catch(error => showNotice(error.message, true));
  function preserveMetadataDraft() {
    if (metadataSaved) return;
    const tab = getActive();
    if (!tab) return;
    const date = metadataForm.elements.date.value;
    const tags = parseTags(metadataForm.elements.tags.value);
    const page = pdfMode ? Number(pageInput.value) : tab.page;
    if (date !== tab.date || tags.join('\u0000') !== tab.tags.join('\u0000') || page !== tab.page) {
      Object.assign(tab, { date, tags, page, dirty: true });
      $('[data-nw-status]').textContent = '未保存';
      renderTabs();
    }
  }
  $('[data-nw-cancel]').onclick = () => { if (!saving) { pendingMove = null; preserveMetadataDraft(); metadata.close(); } };
  metadata.addEventListener('cancel', event => { if (saving) event.preventDefault(); else { pendingMove = null; preserveMetadataDraft(); } });
  metadataForm.addEventListener('submit', save);
  for (const button of modes) button.onclick = () => {
    syncDraft();
    const tab = getActive();
    if (!tab) return;
    tab.mode = button.dataset.nwMode;
    selectedReadingText = '';
    updateMode(tab, { focus: true });
  };
  panel.addEventListener('click', event => handleMarkdownLink(event, {
    openLink: url => window.stilltimeDesktop.workbench.openLink(url),
    onError: error => showNotice(error.message || '链接打开失败。', true),
  }));
  body.addEventListener('compositionstart', () => { composing = true; clearTimeout(previewTimer); });
  body.addEventListener('compositionend', () => {
    composing = false;
    if (content.dataset.mode === 'preview') renderPreview();
  });
  body.addEventListener('input', () => {
    syncDraft();
    const tab = getActive();
    if (!tab) return;
    if (content.dataset.mode === 'reading') {
      tab.mode = 'preview';
      updateMode(tab);
    }
    clearTimeout(previewTimer);
    if (!composing && content.dataset.mode === 'preview') previewTimer = setTimeout(renderPreview, 90);
    const generated = titleFromBody(tab.body);
    $('[data-nw-title]').textContent = generated;
    $('[data-nw-status]').textContent = tab.conflict ? '外部版本冲突 · 有未保存修改' : '未保存';
    saveButton.disabled = !tab.body.trim() || saving;
    renderTabs();
  });
  function readingSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const text = selection?.toString().trim();
    if (!text || !range || !preview.contains(range.commonAncestorContainer)) return null;
    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const paragraph = element.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre');
    return { text, sentence: paragraph?.textContent.trim() || text };
  }
  $('[data-nw-translate]').onpointerdown = () => { selectedReadingText = readingSelection(); };
  $('[data-nw-translate]').onclick = () => {
    const renderedSelection = readingSelection() || selectedReadingText;
    selectedReadingText = null;
    const selection = content.dataset.mode === 'reading' || renderedSelection
      ? (renderedSelection?.text ?? '') : body.value.slice(body.selectionStart, body.selectionEnd);
    if (!selection.trim()) { showNotice('请先选中正文内容。'); return; }
    const start = Math.max(body.value.lastIndexOf('\n', body.selectionStart - 1), body.value.lastIndexOf('。', body.selectionStart - 1));
    const ends = ['\n', '。'].map(character => body.value.indexOf(character, body.selectionEnd)).filter(index => index >= 0);
    const end = ends.length ? Math.min(...ends) + 1 : body.value.length;
    const tab = getActive();
    onTranslate?.({ text: selection, sentence: renderedSelection?.sentence ?? body.value.slice(start + 1, end).trim(), source: {
      type: pdfMode ? 'pdf' : fileMode ? 'document' : 'note', title: tab?.title || titleFromBody(body.value), noteId: tab?.id ?? undefined,
      kind: tab?.kind ?? safeKind, fileId: file?.id ?? tab?.fileId, page: tab?.page ?? undefined,
    } });
  };
  search.oninput = () => void load();
  renderCategories();
  if (addTemplate) {
    const picker = addTemplate(body);
    if (picker instanceof HTMLElement) content.after(picker);
  }
  if (!sharedTabs.length) { createDraft(false); body.blur(); }
  else {
    const active = sharedTabs.find(tab => tab.key === session.activeKey) ?? sharedTabs.at(-1);
    activate(active);
  }
  void load();

  return {
    load,
    onExternalChange: notifyExternalChange,
    onViewEnter() {
      if (externalRefreshPending) void load({ reconcile: true });
    },
    requestSave,
    newDraft: () => createDraft(),
    pendingEntries() {
      syncDraft();
      if (metadata.open) preserveMetadataDraft();
      return sharedTabs.filter(tab => tab.dirty).map(tab => ({
        key: tab.key,
        label: tab.title || titleFromBody(tab.body),
        context: linkMode ? '链接笔记' : pdfMode ? `${file.name} · 阅读笔记` : titleForKind(tab.kind),
      }));
    },
    focusDraft(key) {
      const tab = sharedTabs.find(item => item.key === key);
      if (!tab) return false;
      if (metadata.open) {
        preserveMetadataDraft();
        metadata.close();
      }
      activate(tab);
      if (content.dataset.mode === 'reading') tab.mode = 'preview';
      updateMode(tab, { focus: true });
      return true;
    },
    async saveDraft(key, values) {
      syncDraft();
      const tab = sharedTabs.find(item => item.key === key);
      if (!tab) throw new Error('未保存的笔记草稿已关闭。');
      if (metadata.open && session.activeKey === tab.key) {
        preserveMetadataDraft();
        metadata.close();
      }
      return saveTab(tab, values);
    },
    async openResult(id, itemKind = safeKind, anchor = null) {
      const item = linkMode ? await linkApi.getLinkNote(linkId, id) : (await api.listNotes({ kind: itemKind, fileId: file?.id })).find(note => note.id === id);
      if (!item) return false;
      activate(itemToTab(item, itemKind));
      if (pdfMode && item.page) await options.jumpToPage?.(item.page);
      if (anchor && selectAnchor) {
        getActive().mode = 'source';
        updateMode(getActive());
        selectAnchor(body, anchor);
      }
      return true;
    },
    onPageChange(page, total) {
      if (!pdfMode) return;
      pageInput.max = total;
      const tab = getActive();
      if (tab && !tab.id && !tab.dirty) {
        tab.page = page;
        $('[data-nw-location]').textContent = `第 ${page} 页`;
      }
    },
    isDirty() { syncDraft(); return sharedTabs.some(tab => tab.dirty); },
    canSwitch() { return !saving; },
    dispose({ discard = false } = {}) {
      syncDraft();
      disposed = true;
      clearTimeout(previewTimer);
      if (discard) draftsByContext.delete(context);
    },
  };
}

export function hasUnsavedNoteDrafts() {
  return [...draftsByContext.values()].some(session => session.tabs.some(tab => tab.dirty));
}
