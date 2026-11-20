const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const parseTags = value => [...new Set(String(value ?? '').split(/[,，、\n]+/).map(tag => tag.trim()).filter(Boolean))];
const matches = (item, query) => !query || [item.url, item.title, item.note, ...(item.tags ?? [])]
  .join('\n').toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN'));

/**
 * Mount the combined URL collection, linked notes and embedded browser.
 * @param {HTMLElement} panel
 * @param {{api: object, browserApi: object, node: Function, notify: Function, errorText: Function,
 *   show: Function, setupNotes: Function, createSourceIdea: Function}} options
 */
export function setupWebCollection(panel, { api, browserApi, node, notify, errorText, show, setupNotes, createSourceIdea }) {
  panel.classList.add('web-collection');
  panel.innerHTML = `
    <header class="web-collection__toolbar">
      <div class="web-collection__address-row">
        <input data-wc-url type="url" inputmode="url" placeholder="输入网页地址后回车访问" aria-label="网页地址">
        <button type="button" data-wc-open>保存并打开</button>
        <button type="button" data-wc-back aria-label="后退" title="后退">←</button>
        <button type="button" data-wc-forward aria-label="前进" title="前进">→</button>
        <button type="button" data-wc-reload aria-label="刷新网页" title="刷新">↻</button>
        <span data-wc-browser-title>输入网址后开始浏览</span>
        <button type="button" data-wc-external>默认浏览器</button>
      </div>
      <div class="web-collection__meta-row">
        <input data-wc-title placeholder="收藏标题" aria-label="收藏标题">
        <input data-wc-tags placeholder="标签，用逗号分隔" aria-label="收藏标签">
        <button type="button" data-wc-save>保存信息</button>
        <button type="button" data-wc-later aria-pressed="false">稍后读</button>
        <button type="button" data-wc-archive aria-pressed="false">归档</button>
        <button type="button" data-wc-idea hidden>转为灵感</button>
        <span data-wc-message role="status"></span>
      </div>
    </header>
    <div class="web-collection__columns">
      <aside class="web-collection__directory" aria-label="网页收藏目录">
        <div class="web-collection__directory-head"><h2>网页收藏</h2><button type="button" data-wc-refresh title="刷新目录">刷新</button></div>
        <nav class="web-collection__sections" aria-label="收藏分区"></nav>
        <input data-wc-search type="search" placeholder="搜索网址、标题、标签" aria-label="搜索收藏">
        <div class="web-collection__list" aria-live="polite"></div>
      </aside>
      <section class="web-collection__notes" aria-label="关联笔记"><div data-wc-notes></div></section>
      <section class="web-collection__page" aria-label="内嵌网页">
        <div class="web-collection__browser-placeholder" data-wc-placeholder>选择收藏或输入网址开始浏览。</div>
        <div class="web-collection__viewport" data-wc-viewport></div>
        <div class="web-collection__error" data-wc-error role="status" hidden></div>
      </section>
    </div>`;

  const $ = selector => panel.querySelector(selector);
  const list = $('[data-wc-url]');
  const title = $('[data-wc-title]');
  const tagField = $('[data-wc-tags]');
  const search = $('[data-wc-search]');
  const directoryList = $('.web-collection__list');
  const sectionNav = $('.web-collection__sections');
  const notesMount = $('[data-wc-notes]');
  const viewport = $('[data-wc-viewport]');
  const message = $('[data-wc-message]');
  const browserTitle = $('[data-wc-browser-title]');
  const errorPanel = $('[data-wc-error]');
  const placeholder = $('[data-wc-placeholder]');
  const noteWorkspaces = new Map();
  const metadataDrafts = new Map();
  const sections = [
    { id: 'all', label: '全部' },
    { id: 'inbox', label: '收件箱' },
    { id: 'later', label: '稍后读' },
    { id: 'archived', label: '已归档' },
  ];
  let links = [];
  let selected;
  let activeSection = 'all';
  let browserState = {};
  let listRequest = 0;
  let boundsFrame = 0;
  let linkWritePending = false;
  let selectedFolderPath = '';
  let linkFolders = [];
  const mainViewport = document.getElementById('wb-main');

  function setLinkWritePending(value) {
    linkWritePending = value;
    for (const selector of ['[data-wc-url]', '[data-wc-title]', '[data-wc-tags]', '[data-wc-save]', '[data-wc-open]', '[data-wc-later]', '[data-wc-archive]', '[data-wc-refresh]']) {
      $(selector).disabled = value;
    }
    if (value) showMessage('正在保存链接信息…');
  }

  function rememberMetadataDraft() {
    if (!selected) return;
    const tags = tagField.value;
    if (title.value !== selected.title || tags !== (selected.tags ?? []).join('，')) {
      metadataDrafts.set(selected.id, { title: title.value, tags });
    } else metadataDrafts.delete(selected.id);
  }

  function showMessage(value, isError = false) {
    message.textContent = value;
    message.dataset.error = String(isError);
  }

  function filteredLinks() {
    return links.filter(item => {
      if (activeSection === 'archived') return item.archived === true;
      if (item.archived === true) return false;
      if (activeSection === 'inbox') return item.status === 'inbox';
      if (activeSection === 'later') return item.readLater === true;
      if (activeSection.startsWith('tag:')) return (item.tags ?? []).some(tag => tag.toLocaleLowerCase('zh-CN') === activeSection.slice(4).toLocaleLowerCase('zh-CN'));
      return true;
    }).filter(item => matches(item, search.value));
  }

  function renderSections() {
    const tags = [...new Set(links.flatMap(item => item.tags ?? []))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const values = [...sections, ...tags.map(tag => ({ id: `tag:${tag}`, label: tag }))];
    if (!values.some(item => item.id === activeSection)) activeSection = 'all';
    sectionNav.replaceChildren(...values.map(section => {
      const button = node('button', 'web-collection__section', section.label);
      button.type = 'button';
      button.setAttribute('aria-current', String(section.id === activeSection));
      button.onclick = () => { activeSection = section.id; renderSections(); renderList(); };
      return button;
    }));
  }

  function makeLinkEntry(item, showPath = false) {
    const button = node('button', 'web-collection__entry', '');
    button.type = 'button';
    button.setAttribute('aria-current', String(item.id === selected?.id));
    const label = node('strong', '', item.title || item.url);
    const href = node('span', '', item.url);
    const hint = node('span', 'web-collection__entry-tags', (item.tags ?? []).join(' · '));
    button.append(label, href, hint);
    if (showPath && item.folderPath) button.append(node('small', 'web-collection__entry-path', item.folderPath));
    button.onclick = () => void selectLink(item);
    button.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); void collectionMenu(item.folderPath ?? '', item); };
    return button;
  }

  function renderList() {
    const shown = filteredLinks();
    const rows = [];
    if (search.value) {
      rows.push(...shown.map(item => makeLinkEntry(item, true)));
    } else {
      rows.push(renderFolderBranch('', 0, shown));
      rows.push(...shown.filter(item => !item.folderPath).map(item => makeLinkEntry(item)));
    }
    if (!shown.length && !linkFolders.length) rows.push(node('p', 'web-collection__empty', search.value ? '没有匹配的收藏。' : '这个分区还没有网页。'));
    directoryList.replaceChildren(...rows);
  }

  const expandedFolders = new Set();
  function renderFolderBranch(parentPath, depth, visibleLinks = filteredLinks()) {
    const branch = node('div', 'web-collection__folder-branch', '');
    const children = linkFolders.filter(folder => {
      const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
      return parent === parentPath;
    });
    for (const folderPath of children) {
      const name = folderPath.slice(parentPath ? parentPath.length + 1 : 0);
      const row = node('div', 'web-collection__folder-row', '');
      row.style.paddingInlineStart = `${depth * 12}px`;
      const expand = node('button', 'web-collection__folder-toggle', expandedFolders.has(folderPath) ? '▾' : '▸');
      expand.type = 'button'; expand.onclick = () => { expandedFolders.has(folderPath) ? expandedFolders.delete(folderPath) : expandedFolders.add(folderPath); renderList(); };
      const select = node('button', 'web-collection__folder', name);
      select.type = 'button'; select.setAttribute('aria-current', String(selectedFolderPath === folderPath));
      select.onclick = () => { selectedFolderPath = folderPath; expandFolderPath(folderPath); renderList(); };
      select.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); void collectionMenu(folderPath); };
      row.append(expand, select); branch.append(row);
      if (expandedFolders.has(folderPath)) {
        branch.append(...visibleLinks.filter(item => item.folderPath === folderPath).map(item => {
          const entry = makeLinkEntry(item);
          entry.style.marginInlineStart = `${(depth + 1) * 12}px`;
          return entry;
        }));
        branch.append(renderFolderBranch(folderPath, depth + 1, visibleLinks));
      }
    }
    return branch;
  }

  function expandFolderPath(folderPath, includeSelf = true) {
    const parts = String(folderPath ?? '').split('/').filter(Boolean);
    const limit = includeSelf ? parts.length : Math.max(0, parts.length - 1);
    for (let index = 1; index <= limit; index++) expandedFolders.add(parts.slice(0, index).join('/'));
  }

  function startNewBookmark(folderPath) {
    rememberMetadataDraft();
    selected = null;
    selectedFolderPath = folderPath;
    expandFolderPath(folderPath);
    list.value = '';
    title.value = '';
    tagField.value = '';
    updateMetadataFields();
    for (const entry of noteWorkspaces.values()) entry.mount.hidden = true;
    renderList();
    list.focus();
  }

  async function collectionMenu(parentPath = selectedFolderPath, item = null) {
    const choice = await folderDialog({ actions: item ? ['新建收藏', '新建文件夹', '移动到'] : ['新建收藏', '新建文件夹'] });
    if (!choice) return;
    try {
      if (choice.action === '新建收藏') startNewBookmark(parentPath);
      else if (choice.action === '新建文件夹') {
        if (!choice.name?.trim()) { showMessage('文件夹名称不能为空。', true); return; }
        await api.createFolder({ scope: 'links', parentPath, name: choice.name.trim() });
        selectedFolderPath = [parentPath, choice.name.trim()].filter(Boolean).join('/');
        expandFolderPath(selectedFolderPath);
        await loadLinks();
        showMessage('文件夹已创建。');
      } else if (choice.action === '移动到' && item) {
        rememberMetadataDraft();
        const dirty = selected?.id === item.id && metadataDrafts.has(item.id);
        if (dirty) {
          if (!confirm('收藏信息有未保存修改。保存后移动？')) return;
          if (!await saveLink()) return;
          item = links.find(value => value.id === item.id) ?? item;
        }
        const moved = await api.moveRecord({ scope: 'links', relativePath: item.path ?? `${item.id}.md`, destination: choice.destination, expectedContentHash: item.contentHash });
        selectedFolderPath = choice.destination;
        expandFolderPath(choice.destination);
        await loadLinks();
        if (selected?.id === moved.id) updateMetadataFields();
        renderList();
        showMessage('收藏已移动。');
      }
    } catch (error) { showMessage(errorText(error), true); }
  }

  function folderDialog({ actions }) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'web-collection__folder-dialog';
      const form = document.createElement('form'); form.method = 'dialog';
      const heading = node('h2', '', '收藏目录'); form.append(heading);
      const actionSelect = document.createElement('select');
      for (const action of actions) { const option = document.createElement('option'); option.value = action; option.textContent = action; actionSelect.append(option); }
      form.append(actionSelect);
      const name = document.createElement('input'); name.placeholder = '文件夹名称'; name.hidden = true; form.append(name);
      const destination = document.createElement('select');
      const root = document.createElement('option'); root.value = ''; root.textContent = '根目录'; destination.append(root);
      for (const folderPath of linkFolders) { const option = document.createElement('option'); option.value = folderPath; option.textContent = folderPath; destination.append(option); }
      destination.hidden = true; form.append(destination);
      const footer = document.createElement('footer'); const cancel = node('button', '', '取消'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
      const save = node('button', '', '确定'); save.type = 'submit'; footer.append(cancel, save); form.append(footer); dialog.append(form); panel.append(dialog);
      actionSelect.onchange = () => { name.hidden = actionSelect.value !== '新建文件夹'; destination.hidden = actionSelect.value !== '移动到'; };
      actionSelect.dispatchEvent(new Event('change'));
      dialog.addEventListener('close', () => { resolve(dialog.returnValue ? { action: dialog.returnValue, name: name.value, destination: destination.value } : null); dialog.remove(); }, { once: true });
      form.onsubmit = event => { event.preventDefault(); dialog.returnValue = actionSelect.value; dialog.close(); };
      dialog.showModal();
    });
  }

  function updateMetadataFields() {
    list.value = selected?.url ?? list.value;
    const draft = selected && metadataDrafts.get(selected.id);
    title.value = draft?.title ?? selected?.title ?? '';
    tagField.value = draft?.tags ?? (selected?.tags ?? []).join('，');
    $('[data-wc-later]').setAttribute('aria-pressed', String(Boolean(selected?.readLater)));
    $('[data-wc-archive]').setAttribute('aria-pressed', String(Boolean(selected?.archived)));
    $('[data-wc-idea]').hidden = !selected;
    $('[data-wc-later]').textContent = selected?.readLater ? '取消稍后读' : '稍后读';
    $('[data-wc-archive]').textContent = selected?.archived ? '取消归档' : '归档';
  }

  function ensureNoteWorkspace(link) {
    let entry = noteWorkspaces.get(link.id);
    if (!entry) {
      const mount = node('div', 'web-collection__note-workspace');
      notesMount.append(mount);
      const workspace = setupNotes(mount, { linkId: link.id, linkApi: api });
      entry = { mount, workspace };
      noteWorkspaces.set(link.id, entry);
    }
    for (const value of noteWorkspaces.values()) value.mount.hidden = value !== entry;
    return entry;
  }

  async function selectLink(item, { noteName, anchor } = {}) {
    rememberMetadataDraft();
    selected = item;
    selectedFolderPath = item.folderPath ?? '';
    expandFolderPath(selectedFolderPath);
    updateMetadataFields();
    renderList();
    const entry = ensureNoteWorkspace(item);
    if (noteName) await entry.workspace.openResult(noteName, 'link-note', anchor);
    else await entry.workspace.onExternalChange?.();
    $('[data-wc-placeholder]').hidden = true;
    await browserApi.navigate(item.url).catch(error => {
      showMessage(errorText(error), true);
      errorPanel.textContent = errorText(error);
      errorPanel.hidden = false;
    });
    syncBounds();
    return true;
  }

  async function loadLinks() {
    const request = ++listRequest;
    try {
      if (!linkWritePending) rememberMetadataDraft();
      const [result, folders] = await Promise.all([api.listLinks(''), api.listFolders({ scope: 'links' })]);
      if (request !== listRequest) return;
      links = result.map(item => ({ archived: false, ...item }));
      linkFolders = folders;
      selected = selected && links.find(item => item.id === selected.id) || null;
      if (selected) {
        selectedFolderPath = selected.folderPath ?? '';
        expandFolderPath(selectedFolderPath);
      }
      updateMetadataFields();
      renderSections();
      renderList();
    } catch (error) {
      directoryList.replaceChildren(node('p', 'web-collection__empty', errorText(error)));
    }
  }

  async function saveLink({ open = false } = {}) {
    if (linkWritePending) return false;
    let url = list.value.trim();
    if (!url) { showMessage('先输入网址。', true); list.focus(); return false; }
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
    setLinkWritePending(true);
    try {
      const result = await api.saveLink({
        id: selected?.id,
        folderPath: selected?.folderPath ?? selectedFolderPath,
        url,
        title: title.value.trim(),
        tags: parseTags(tagField.value),
        note: selected?.note ?? '',
        readLater: selected?.readLater === true,
        archived: selected?.archived === true,
      });
      if (!result.item) throw new Error('保存链接失败。');
      metadataDrafts.delete(result.item.id);
      if (result.duplicate) {
        selected = result.item;
        showMessage('此网址已收藏，已打开原收藏。');
      } else {
        selected = result.item;
        showMessage('网址已保存。');
      }
      await loadLinks();
      if (open) {
        selected = links.find(item => item.id === result.item.id) ?? result.item;
        updateMetadataFields();
        await selectLink(selected);
      }
      return true;
    } catch (error) {
      showMessage(errorText(error), true);
      return false;
    } finally { setLinkWritePending(false); }
  }

  async function toggleSelected(key) {
    if (!selected || linkWritePending) return;
    const input = {
      id: selected.id, url: selected.url, title: selected.title,
      tags: selected.tags ?? [], note: selected.note ?? '',
      readLater: key === 'readLater' ? !selected.readLater : selected.readLater === true,
      archived: key === 'archived' ? !selected.archived : selected.archived === true,
    };
    setLinkWritePending(true);
    try {
      const result = await api.saveLink(input);
      selected = result.item;
      await loadLinks();
      updateMetadataFields();
      renderList();
      showMessage(key === 'archived' ? (selected.archived ? '已归档。' : '已取消归档。') : (selected.readLater ? '已加入稍后读。' : '已移出稍后读。'));
    } catch (error) { showMessage(errorText(error), true); }
    finally { setLinkWritePending(false); }
  }

  function syncBounds() {
    cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      const rect = viewport.getBoundingClientRect();
      const clip = mainViewport?.getBoundingClientRect();
      const clipLeft = clip ? clip.left + mainViewport.clientLeft : rect.left;
      const clipTop = clip ? clip.top + mainViewport.clientTop : rect.top;
      const clipRight = clip ? clipLeft + mainViewport.clientWidth : rect.right;
      const clipBottom = clip ? clipTop + mainViewport.clientHeight : rect.bottom;
      const left = Math.max(rect.left, clipLeft);
      const top = Math.max(rect.top, clipTop);
      const right = Math.min(rect.right, clipRight);
      const bottom = Math.min(rect.bottom, clipBottom);
      const hasOverlay = Boolean(document.querySelector('dialog[open], [role="dialog"]:not([hidden]), #wb-appearance-panel:not([hidden]), [popover]:popover-open'));
      const activePage = !panel.hidden && !document.getElementById('wb-links')?.hidden;
      const visible = activePage && !hasOverlay && !browserState.error && Boolean(browserState.url) && right > left && bottom > top;
      if (!visible) void browserApi.hide();
      else void browserApi.setBounds({ x: left, y: top, width: right - left, height: bottom - top })
        .catch(error => showMessage(errorText(error), true));
    });
  }

  function updateBrowserState(state = {}) {
    browserState = state;
    const value = state.title || state.url || '内嵌网页';
    browserTitle.textContent = state.loading ? `${value} · 正在加载` : value;
    $('[data-wc-back]').disabled = !state.canGoBack;
    $('[data-wc-forward]').disabled = !state.canGoForward;
    errorPanel.textContent = state.error || '';
    errorPanel.hidden = !state.error;
    syncBounds();
  }

  async function navigateAddress({ save = false } = {}) {
    if (save) {
      if (!await saveLink({ open: false })) return;
      if (selected) {
        await selectLink(selected);
        return;
      }
    }
    try {
      const url = list.value.trim();
      if (!url) return;
      await browserApi.navigate(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
      errorPanel.hidden = true;
      placeholder.hidden = true;
      syncBounds();
    } catch (error) {
      errorPanel.textContent = errorText(error);
      errorPanel.hidden = false;
    }
  }

  $('[data-wc-open]').onclick = () => void navigateAddress({ save: true });
  list.addEventListener('input', () => {
    if (selected && list.value.trim() !== selected.url) {
      rememberMetadataDraft();
      selected = null;
      for (const entry of noteWorkspaces.values()) entry.mount.hidden = true;
      updateMetadataFields();
    }
  });
  list.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void navigateAddress(); }
  });
  $('[data-wc-save]').onclick = () => void saveLink();
  $('[data-wc-later]').onclick = () => void toggleSelected('readLater');
  $('[data-wc-archive]').onclick = () => void toggleSelected('archived');
  $('[data-wc-idea]').onclick = () => {
    if (selected) void createSourceIdea?.({ type: 'link', linkId: selected.id, url: selected.url, title: selected.title });
  };
  $('[data-wc-refresh]').onclick = () => void loadLinks();
  $('[data-wc-back]').onclick = () => void browserApi.back();
  $('[data-wc-forward]').onclick = () => void browserApi.forward();
  $('[data-wc-reload]').onclick = () => void browserApi.reload();
  $('[data-wc-external]').onclick = () => void browserApi.openExternal().catch(error => showMessage(errorText(error), true));
  search.oninput = () => renderList();
  directoryList.addEventListener('contextmenu', event => {
    if (event.target.closest('.web-collection__entry')) return;
    event.preventDefault();
    void collectionMenu('');
  });
  title.oninput = () => { rememberMetadataDraft(); if (selected) showMessage('有未保存的修改'); };
  tagField.oninput = () => { rememberMetadataDraft(); if (selected) showMessage('有未保存的修改'); };
  const unsubscribe = browserApi.onState(updateBrowserState);
  const resizeObserver = new ResizeObserver(syncBounds);
  resizeObserver.observe(viewport);
  window.addEventListener('resize', syncBounds);
  const visibilityObserver = new MutationObserver(syncBounds);
  visibilityObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  const pageObserver = new MutationObserver(syncBounds);
  if (document.getElementById('wb-links')) pageObserver.observe(document.getElementById('wb-links'), { attributes: true, attributeFilter: ['hidden'] });
  const overlayObserver = new MutationObserver(syncBounds);
  overlayObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'aria-modal'] });
  mainViewport?.addEventListener('scroll', syncBounds, { passive: true });
  void browserApi.state().then(updateBrowserState).catch(() => {});
  void loadLinks();

  return {
    load: loadLinks,
    location: () => '网页收藏',
    async onExternalChange(categories = []) {
      const changed = new Set(Array.isArray(categories) ? categories : [categories]);
      if (!changed.size || changed.has('links')) await loadLinks();
      if (!changed.size || changed.has('linknotes')) {
        const entry = selected && noteWorkspaces.get(selected.id);
        if (entry && !entry.mount.hidden && !panel.closest('[hidden]')) await entry.workspace.onExternalChange?.();
      }
    },
    requestSave: async () => {
      const activeWorkspace = selected && noteWorkspaces.get(selected.id)?.workspace;
      if (activeWorkspace?.isDirty()) return activeWorkspace.requestSave();
      if (selected && (title.value !== selected.title || tagField.value !== (selected.tags ?? []).join('，'))) return saveLink();
      return false;
    },
    isDirty: () => [...noteWorkspaces.values()].some(value => value.workspace.isDirty()) ||
      Boolean(selected && (title.value !== selected.title || tagField.value !== (selected.tags ?? []).join('，'))),
    pending: () => {
      const entries = [...noteWorkspaces.values()].flatMap(value => value.workspace.pending?.() ?? []);
      for (const [linkId, draft] of metadataDrafts) {
        const item = links.find(link => link.id === linkId);
        if (!item) continue;
        entries.unshift({
          key: `web-collection-metadata:${linkId}`,
          title: draft.title.trim() || item.url,
          location: '网页收藏',
          activate: () => {
            show('links', { load: false });
            selected = item;
            updateMetadataFields();
          },
          save: async () => {
            selected = item;
            updateMetadataFields();
            return saveLink();
          },
        });
      }
      return entries;
    },
    openSource: async id => {
      let item = links.find(link => link.id === id);
      if (!item) {
        await loadLinks();
        item = links.find(link => link.id === id);
      }
      if (!item) return false;
      show('links', { load: false });
      return selectLink(item);
    },
    openSourceNote: async (id, name, anchor) => {
      let item = links.find(link => link.id === id);
      if (!item) {
        await loadLinks();
        item = links.find(link => link.id === id);
      }
      if (!item) return false;
      show('links', { load: false });
      return selectLink(item, { noteName: name, anchor });
    },
    dispose() {
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      pageObserver.disconnect();
      overlayObserver.disconnect();
      mainViewport?.removeEventListener('scroll', syncBounds);
      window.removeEventListener('resize', syncBounds);
      unsubscribe?.();
      void browserApi.hide();
    },
  };
}
