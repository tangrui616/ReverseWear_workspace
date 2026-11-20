const STATUSES = [
  ['inbox', '收件箱'],
  ['later', '稍后深读'],
  ['archive', '已归档'],
];

const SAFE_TAGS = new Set([
  'article', 'section', 'div', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's',
  'span', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub', 'dl', 'dt', 'dd', 'mark', 'time',
]);

function safeUrl(value, base, image = false) {
  try {
    if (image) {
      const source = String(value || '');
      if (source.startsWith('/')) {
        if (!/^\/api\/articles\/[a-z\d_-]+\/(?:cover|icon)(?:\?[^#]*)?$/i.test(source)) return '';
        return source;
      }
      const url = new URL(source, window.location.href);
      if (url.origin !== window.location.origin) return '';
      return /^\/api\/articles\/[a-z\d_-]+\/(?:cover|icon)(?:\?[^#]*)?$/i.test(url.pathname + url.search) ? url.href : '';
    }
    if (typeof value !== 'string' || !value.trim()) return '';
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function safeArticleFragment(source, baseUrl) {
  const documentSource = new DOMParser().parseFromString(String(source || ''), 'text/html');
  const output = document.createDocumentFragment();
  const copy = (sourceNode, targetParent) => {
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      targetParent.append(document.createTextNode(sourceNode.nodeValue || ''));
      return;
    }
    if (sourceNode.nodeType !== Node.ELEMENT_NODE) return;
    const tag = sourceNode.tagName.toLowerCase();
    if (!SAFE_TAGS.has(tag)) {
      for (const child of sourceNode.childNodes) copy(child, targetParent);
      return;
    }
    const element = document.createElement(tag);
    if (tag === 'a') {
      const href = safeUrl(sourceNode.getAttribute('href'), baseUrl);
      if (href) {
        element.href = href;
        element.rel = 'noopener noreferrer';
      }
      const title = sourceNode.getAttribute('title');
      if (title) element.title = title.slice(0, 300);
    } else if (tag === 'img') {
      const src = safeUrl(sourceNode.getAttribute('src'), baseUrl, true);
      if (!src) return;
      element.src = src;
      element.alt = (sourceNode.getAttribute('alt') || '').slice(0, 400);
      element.loading = 'lazy';
      element.referrerPolicy = 'no-referrer';
    } else if (tag === 'th' || tag === 'td') {
      const scope = sourceNode.getAttribute('scope');
      if (tag === 'th' && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) element.scope = scope;
    }
    for (const child of sourceNode.childNodes) copy(child, element);
    targetParent.append(element);
  };
  for (const child of documentSource.body.childNodes) copy(child, output);
  return output;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requestArticleNote() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'article-inbox__dialog';
    dialog.dataset.dialogKind = 'article-note';
    const form = element('form', 'article-inbox__dialog-form');
    form.method = 'dialog';
    const heading = element('h2', '', '添加阅读批注');
    const label = element('label', '', '批注内容');
    const input = element('textarea');
    input.dataset.dialogInput = '';
    input.maxLength = 500;
    input.rows = 4;
    input.placeholder = '写下这段原文的想法…';
    label.append(input);
    const actions = element('div', 'article-inbox__dialog-actions');
    const cancel = element('button', '', '取消');
    cancel.type = 'button'; cancel.dataset.dialogCancel = '';
    const save = element('button', 'is-primary', '保存批注');
    save.type = 'submit'; save.dataset.dialogSubmit = '';
    actions.append(cancel, save);
    form.append(heading, label, actions);
    dialog.append(form);
    document.body.append(dialog);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); finish(null); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    form.addEventListener('submit', event => { event.preventDefault(); finish(input.value.trim()); });
    dialog.showModal();
    input.focus();
  });
}

function confirmArticleDelete(title) {
  return new Promise(resolve => {
    const dialog = element('dialog', 'article-inbox__dialog');
    dialog.dataset.dialogKind = 'article-delete';
    const form = element('form', 'article-inbox__dialog-form');
    form.method = 'dialog';
    const heading = element('h2', '', '删除文章');
    const message = element('p', '', '删除《' + title + '》及其本地快照、附件和批注？已写入工作台的笔记会保留。');
    const actions = element('div', 'article-inbox__dialog-actions');
    const cancel = element('button', '', '取消');
    cancel.value = 'cancel';
    cancel.autofocus = true;
    cancel.dataset.dialogCancel = '';
    const remove = element('button', '', '确认删除');
    remove.value = 'delete';
    remove.dataset.dialogSubmit = '';
    actions.append(cancel, remove);
    form.append(heading, message, actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'delete';
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    dialog.showModal();
  });
}

export function setupArticleInbox(panel, api, { notice = () => {} } = {}) {
  panel.classList.add('article-inbox');
  panel.replaceChildren();

  const shell = element('div', 'article-inbox__shell');
  const sidebar = element('aside', 'article-inbox__sidebar');
  const brand = element('div', 'article-inbox__brand');
  brand.append(element('h2', '', '阅读收件箱'));
  sidebar.append(brand);
  const statusNav = element('nav', 'article-inbox__status-nav');
  statusNav.setAttribute('aria-label', '阅读状态');
  const domainNav = element('section', 'article-inbox__filter-group');
  const domainHeading = element('h3', '', '网站');
  const domainItems = element('div', 'article-inbox__filter-items');
  domainNav.append(domainHeading, domainItems);
  const tagNav = element('section', 'article-inbox__filter-group');
  const tagHeading = element('h3', '', '标签');
  const tagItems = element('div', 'article-inbox__filter-items');
  tagNav.append(tagHeading, tagItems);
  sidebar.append(statusNav, domainNav, tagNav);

  const center = element('section', 'article-inbox__center');
  const toolbar = element('header', 'article-inbox__toolbar');
  const headingGroup = element('div', 'article-inbox__heading');
  const heading = element('h1', '', '收件箱');
  const count = element('span', 'article-inbox__count', '0 篇');
  headingGroup.append(heading, count);
  const toolbarActions = element('div', 'article-inbox__toolbar-actions');
  const searchLabel = element('label', 'article-inbox__search');
  searchLabel.append(element('span', '', '⌕'));
  const searchInput = element('input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索文章标题、网站或标签';
  searchInput.setAttribute('aria-label', '搜索文章');
  searchLabel.append(searchInput);
  const viewToggle = element('button', 'article-inbox__view-toggle', '列表');
  viewToggle.type = 'button';
  viewToggle.setAttribute('aria-pressed', 'false');
  const captureForm = element('form', 'article-inbox__capture');
  const urlInput = element('input');
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = '粘贴网页链接';
  urlInput.setAttribute('aria-label', '要保存的网页链接');
  const captureButton = element('button', 'article-inbox__primary', '保存链接');
  captureButton.type = 'submit';
  captureForm.append(urlInput, captureButton);
  toolbarActions.append(searchLabel, viewToggle, captureForm);
  toolbar.append(headingGroup, toolbarActions);
  const list = element('div', 'article-inbox__list');
  list.setAttribute('aria-label', '已保存的文章');
  list.setAttribute('aria-live', 'polite');
  center.append(toolbar, list);

  const reader = element('section', 'article-inbox__reader');
  reader.setAttribute('aria-label', '文章阅读区');
  const readerEmpty = element('div', 'article-inbox__reader-empty', '选择一篇文章开始阅读');
  const readerToolbar = element('header', 'article-inbox__reader-toolbar');
  const readerIdentity = element('div', 'article-inbox__reader-identity');
  const siteLine = element('div', 'article-inbox__site-line');
  const siteIcon = element('img', 'article-inbox__site-icon');
  siteIcon.alt = '';
  siteIcon.hidden = true;
  const siteName = element('span', '', '');
  siteLine.append(siteIcon, siteName);
  const title = element('h2', '', '');
  const articleMeta = element('div', 'article-inbox__meta');
  readerIdentity.append(siteLine, title, articleMeta);
  const readerActions = element('div', 'article-inbox__reader-actions');
  const statusButton = element('button', 'article-inbox__quiet', '稍后深读');
  statusButton.type = 'button';
  const exportButton = element('button', 'article-inbox__quiet', '导出 Markdown');
  exportButton.type = 'button';
  const deleteButton = element('button', 'article-inbox__quiet', '删除文章');
  deleteButton.type = 'button';
  deleteButton.dataset.articleDelete = '';
  readerActions.append(statusButton, exportButton, deleteButton);
  readerToolbar.append(readerIdentity, readerActions);
  const readerSettings = element('div', 'article-inbox__reader-settings');
  const fontControl = element('label', '', '字号');
  const fontRange = element('input');
  fontRange.type = 'range'; fontRange.min = '15'; fontRange.max = '24'; fontRange.value = '18';
  fontRange.setAttribute('aria-label', '文章字号');
  fontControl.append(fontRange);
  const widthControl = element('label', '', '版心');
  const widthRange = element('input');
  widthRange.type = 'range'; widthRange.min = '620'; widthRange.max = '980'; widthRange.value = '760'; widthRange.step = '20';
  widthRange.setAttribute('aria-label', '文章版心宽度');
  widthControl.append(widthRange);
  const warmControl = element('button', 'article-inbox__quiet', '暖色纸张');
  warmControl.type = 'button'; warmControl.setAttribute('aria-pressed', 'false');
  readerSettings.append(fontControl, widthControl, warmControl);
  const articleScroll = element('div', 'article-inbox__article-scroll');
  const articleContent = element('article', 'article-inbox__article');
  articleContent.tabIndex = 0;
  const annotationPanel = element('details', 'article-inbox__annotations');
  const annotationHeading = element('summary', '', '阅读批注');
  const annotationList = element('ul');
  annotationPanel.append(annotationHeading, annotationList);
  annotationPanel.hidden = true;
  articleScroll.append(articleContent, annotationPanel);
  const selectionBar = element('div', 'article-inbox__selection-bar');
  selectionBar.hidden = true;
  selectionBar.setAttribute('role', 'toolbar');
  selectionBar.setAttribute('aria-label', '所选文本操作');
  for (const [label, action] of [['高亮', 'highlight'], ['记笔记', 'note'], ['翻译', 'translate']]) {
    const button = element('button', '', label);
    button.type = 'button';
    button.dataset.selectionAction = action;
    selectionBar.append(button);
  }
  const tagEditor = element('form', 'article-inbox__tag-editor');
  const tagInput = element('input');
  tagInput.placeholder = '添加标签后回车';
  tagInput.setAttribute('aria-label', '文章标签');
  tagEditor.append(tagInput);
  const readerNote = element('p', 'article-inbox__reader-note article-capture-notice');
  readerNote.setAttribute('role', 'status');
  readerNote.hidden = true;
  reader.append(readerEmpty, readerToolbar, readerSettings, articleScroll, selectionBar, tagEditor, readerNote);
  shell.append(sidebar, center, reader);
  panel.append(shell);

  const state = { status: 'inbox', domain: '', tag: '', query: '', selectedId: '', rows: [], detail: null, listMode: false, busy: false, loadVersion: 0 };
  const selectedText = () => window.getSelection()?.toString().trim() || '';

  const reportError = error => notice(error?.message || String(error || '操作失败，请重试。'), true);
  const showNotice = message => { readerNote.textContent = message; readerNote.hidden = false; notice(message); };

  function updateStatusNav() {
    statusNav.replaceChildren();
    for (const [key, label] of STATUSES) {
      const button = element('button', '', label);
      button.type = 'button'; button.dataset.status = key;
      button.setAttribute('aria-current', String(state.status === key));
      statusNav.append(button);
    }
    heading.textContent = STATUSES.find(([key]) => key === state.status)?.[1] || '收件箱';
  }

  function renderFacets(rows) {
    const domains = new Map();
    const tags = new Map();
    for (const row of rows) {
      if (row.domain) domains.set(row.domain, (domains.get(row.domain) || 0) + 1);
      for (const tag of row.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const render = (container, facets, activeValue, key) => {
      container.replaceChildren();
      const all = element('button', '', '全部');
      all.type = 'button'; all.dataset[key] = '';
      all.setAttribute('aria-pressed', String(!activeValue));
      container.append(all);
      for (const [value, total] of [...facets].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
        const button = element('button', '', value + ' · ' + total);
        button.type = 'button'; button.dataset[key] = value;
        button.setAttribute('aria-pressed', String(activeValue === value));
        container.append(button);
      }
    };
    render(domainItems, domains, state.domain, 'domain');
    render(tagItems, tags, state.tag, 'tag');
  }

  function renderList() {
    list.replaceChildren();
    count.textContent = state.rows.length + ' 篇';
    center.classList.toggle('is-list-mode', state.listMode);
    viewToggle.textContent = state.listMode ? '卡片' : '列表';
    viewToggle.setAttribute('aria-pressed', String(state.listMode));
    if (!state.rows.length) {
      const empty = element('div', 'article-inbox__empty');
      empty.append(element('strong', '', '这里还没有文章'), element('p', '', '粘贴网页链接即可保存到收件箱。'));
      list.append(empty);
      return;
    }
    for (const row of state.rows) {
      const card = element('article', 'article-inbox__card');
      card.tabIndex = 0;
      card.dataset.id = row.id;
      card.setAttribute('aria-current', String(row.id === state.selectedId));
      const coverUrl = safeUrl(row.coverUrl, row.url, true);
      if (coverUrl) {
        const cover = element('img', 'article-inbox__cover');
        cover.src = coverUrl; cover.alt = ''; cover.loading = 'lazy'; cover.referrerPolicy = 'no-referrer';
        card.append(cover);
      }
      const body = element('div', 'article-inbox__card-body');
      const cardMeta = element('div', 'article-inbox__card-meta');
      cardMeta.append(element('span', '', row.siteName || row.domain || '网页'), element('span', '', (row.readingMinutes || 1) + ' 分钟'));
      const cardTitle = element('h3', '', row.title || row.url || '未命名文章');
      const excerpt = element('p', 'article-inbox__excerpt', row.excerpt || '');
      const chips = element('div', 'article-inbox__chips');
      for (const tag of row.tags || []) chips.append(element('span', '', tag));
      body.append(cardMeta, cardTitle, excerpt, chips);
      card.append(body);
      list.append(card);
    }
  }

  function applyReaderPreferences() {
    articleContent.style.setProperty('--article-font-size', fontRange.value + 'px');
    articleContent.style.setProperty('--article-width', widthRange.value + 'px');
    reader.classList.toggle('is-warm', warmControl.getAttribute('aria-pressed') === 'true');
  }

  function rangeForTextOffsets(container, start, end) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    let position = 0;
    let startPoint = null;
    let endPoint = null;
    while ((node = walker.nextNode())) {
      const next = position + node.nodeValue.length;
      if (!startPoint && start >= position && start <= next) startPoint = [node, start - position];
      if (end >= position && end <= next) { endPoint = [node, end - position]; break; }
      position = next;
    }
    if (!startPoint || !endPoint) return null;
    const range = document.createRange();
    range.setStart(startPoint[0], startPoint[1]);
    range.setEnd(endPoint[0], endPoint[1]);
    return range;
  }

  function renderAnnotations(detail) {
    const canonical = String(detail.textContent || '');
    const offsetsMatch = canonical === articleContent.textContent;
    const annotations = Array.isArray(detail.annotations) ? detail.annotations : [];
    const highlights = annotations.filter(item => item.kind === 'highlight')
      .sort((a, b) => Number(b.start) - Number(a.start));
    const used = [];
    const located = new Set();
    for (const annotation of offsetsMatch ? highlights : []) {
      const start = Number(annotation.start);
      const end = Number(annotation.end);
      const quote = String(annotation.quote || '');
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || canonical.slice(start, end) !== quote) continue;
      if (used.some(([left, right]) => start < right && end > left)) continue;
      const range = rangeForTextOffsets(articleContent, start, end);
      if (!range) continue;
      const mark = document.createElement('mark');
      mark.className = 'article-inbox__highlight';
      if (annotation.note) mark.title = annotation.note;
      try {
        mark.append(range.extractContents());
        range.insertNode(mark);
        used.push([start, end]);
        located.add(annotation.id);
      } catch { /* Unsupported ranges are listed below with their stored quote. */ }
    }
    const unlocated = highlights.length - located.size;
    annotationHeading.textContent = unlocated ? '阅读批注（' + unlocated + ' 条高亮暂无法定位）' : '阅读批注';
    annotationPanel.hidden = annotations.length === 0;
    annotationList.replaceChildren();
    for (const annotation of annotations) {
      const item = element('li');
      if (annotation.quote) item.append(element('blockquote', '', annotation.quote));
      if (annotation.note) item.append(element('p', '', annotation.note));
      if (annotation.kind === 'highlight') {
        const remove = element('button', 'article-inbox__quiet', '移除高亮');
        remove.type = 'button';
        remove.dataset.annotationRemove = annotation.id;
        if (!located.has(annotation.id)) item.append(element('small', '', '暂无法定位'));
        item.append(remove);
      }
      annotationList.append(item);
    }
  }

  async function loadDetail(id, { focusReader = false } = {}) {
    if (!id) return;
    state.selectedId = id;
    state.detail = null;
    renderList();
    const detail = await api.get({ id });
    if (state.selectedId !== id) return;
    if (!detail) {
      await load();
      return;
    }
    state.detail = detail;
    annotationPanel.open = false;
    readerEmpty.hidden = true;
    readerToolbar.hidden = false;
    readerSettings.hidden = false;
    articleScroll.hidden = false;
    selectionBar.hidden = true;
    tagEditor.hidden = false;
    title.textContent = detail.title || detail.url || '未命名文章';
    siteName.textContent = detail.siteName || detail.domain || '网页';
    const iconUrl = safeUrl(detail.iconUrl, detail.url, true);
    siteIcon.hidden = !iconUrl;
    if (iconUrl) siteIcon.src = iconUrl;
    articleMeta.textContent = [detail.domain || '', (detail.readingMinutes || 1) + ' 分钟', detail.updatedAt ? new Date(detail.updatedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ');
    statusButton.textContent = detail.status === 'later' ? '移出稍后深读' : detail.status === 'archive' ? '恢复到收件箱' : '稍后深读';
    tagInput.value = '';
    articleContent.replaceChildren(safeArticleFragment(detail.contentHtml || '', detail.url));
    renderAnnotations(detail);
    articleScroll.scrollTop = 0;
    articleContent.focus({ preventScroll: !focusReader });
  }

  async function load() {
    const request = ++state.loadVersion;
    try {
      const rows = await api.list({ status: state.status, domain: state.domain, tag: state.tag, query: state.query });
      if (request !== state.loadVersion) return;
      state.rows = Array.isArray(rows) ? rows : [];
      updateStatusNav();
      renderFacets(state.rows);
      if (state.selectedId && !state.rows.some(row => row.id === state.selectedId)) state.selectedId = '';
      if (!state.selectedId && state.rows.length) state.selectedId = state.rows[0].id;
      renderList();
      if (state.selectedId) await loadDetail(state.selectedId);
      else {
        state.detail = null;
        readerEmpty.hidden = false;
        readerToolbar.hidden = true;
        readerSettings.hidden = true;
        articleScroll.hidden = true;
        selectionBar.hidden = true;
        tagEditor.hidden = true;
      }
    } catch (error) { reportError(error); }
  }

  statusNav.addEventListener('click', async event => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.status = button.dataset.status;
    state.domain = ''; state.tag = ''; state.selectedId = '';
    await load();
  });
  domainItems.addEventListener('click', async event => {
    const button = event.target.closest('[data-domain]');
    if (!button) return;
    state.domain = button.dataset.domain; state.tag = ''; state.selectedId = '';
    await load();
  });
  tagItems.addEventListener('click', async event => {
    const button = event.target.closest('[data-tag]');
    if (!button) return;
    state.tag = button.dataset.tag; state.domain = ''; state.selectedId = '';
    await load();
  });
  list.addEventListener('click', event => {
    const card = event.target.closest('[data-id]');
    if (card) void loadDetail(card.dataset.id, { focusReader: true }).catch(reportError);
  });
  list.addEventListener('keydown', event => {
    const card = event.target.closest('[data-id]');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      void loadDetail(card.dataset.id, { focusReader: true }).catch(reportError);
    }
  });
  viewToggle.addEventListener('click', () => { state.listMode = !state.listMode; renderList(); });
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => { state.selectedId = ''; void load(); }, 180);
  });
  captureForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true; captureButton.disabled = true; captureButton.textContent = '正在保存…';
    try {
      const result = await api.capture({ url: urlInput.value.trim() });
      urlInput.value = '';
      state.status = result?.status || 'inbox';
      state.selectedId = result?.id || '';
      state.domain = ''; state.tag = ''; state.query = ''; searchInput.value = '';
      await load();
      showNotice(state.status === 'inbox' ? '网页已保存在收件箱。' : '已打开本地保存的网页。');
    } catch (error) { reportError(error); }
    finally { state.busy = false; captureButton.disabled = false; captureButton.textContent = '保存链接'; }
  });

  statusButton.addEventListener('click', async () => {
    if (!state.detail) return;
    try {
      const status = state.detail.status === 'later' || state.detail.status === 'archive' ? 'inbox' : 'later';
      await api.update({ id: state.detail.id, status });
      showNotice(status === 'later' ? '已加入稍后深读。' : '已移回收件箱。');
      await load();
    } catch (error) { reportError(error); }
  });
  exportButton.addEventListener('click', async () => {
    if (!state.detail) return;
    try {
      const result = await api.export({ id: state.detail.id });
      if (result?.path) showNotice('已导出到 ' + result.path);
    } catch (error) { reportError(error); }
  });
  deleteButton.addEventListener('click', async () => {
    const detail = state.detail;
    if (!detail || deleteButton.disabled) return;
    deleteButton.disabled = true;
    try {
      if (!await confirmArticleDelete(detail.title || '未命名文章')) return;
      const result = await api.delete({ id: detail.id });
      if (state.selectedId === detail.id) state.selectedId = '';
      await load();
      if (result?.cleanupPending) reportError('文章已移除，本地文件将在下次启动时重试清理。');
      else showNotice(result?.deleted || result === true ? '文章已删除。' : '文章已不存在。');
    } catch (error) { reportError(error); }
    finally { deleteButton.disabled = false; }
  });

  annotationList.addEventListener('click', async event => {
    const button = event.target.closest('[data-annotation-remove]');
    const detail = state.detail;
    if (!button || !detail || button.disabled) return;
    button.disabled = true;
    try {
      await api.removeAnnotation({ id: detail.id, annotationId: button.dataset.annotationRemove });
      if (state.detail !== detail) return;
      const current = await api.get({ id: detail.id });
      if (state.detail !== detail) return;
      if (!current) { await load(); return; }
      const scrollTop = articleScroll.scrollTop;
      state.detail = current;
      articleContent.replaceChildren(safeArticleFragment(current.contentHtml || '', current.url));
      renderAnnotations(current);
      articleScroll.scrollTop = scrollTop;
      showNotice('高亮已移除。');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  });

  tagEditor.addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.detail) return;
    const nextTag = tagInput.value.trim().replace(/^#/, '');
    if (!nextTag) return;
    try {
      const tags = [...new Set([...(state.detail.tags || []), nextTag])];
      await api.update({ id: state.detail.id, tags });
      tagInput.value = '';
      showNotice('标签已添加。');
      await load();
    } catch (error) { reportError(error); }
  });

  fontRange.addEventListener('input', applyReaderPreferences);
  widthRange.addEventListener('input', applyReaderPreferences);
  warmControl.addEventListener('click', () => {
    const warm = warmControl.getAttribute('aria-pressed') !== 'true';
    warmControl.setAttribute('aria-pressed', String(warm));
    warmControl.classList.toggle('article-inbox__warm', warm);
    applyReaderPreferences();
  });
  applyReaderPreferences();

  let selectionRange = null;
  const showSelectionBar = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !state.detail) {
      selectionBar.hidden = true;
      selectionRange = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!articleContent.contains(range.commonAncestorContainer)) return;
    selectionRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    const bounds = reader.getBoundingClientRect();
    selectionBar.hidden = false;
    selectionBar.style.left = Math.max(8, Math.min(bounds.width - selectionBar.offsetWidth - 8, rect.left - bounds.left)) + 'px';
    selectionBar.style.top = Math.max(4, rect.top - bounds.top - selectionBar.offsetHeight - 8) + 'px';
  };
  articleContent.addEventListener('click', event => {
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    event.preventDefault();
    if (!event.isTrusted || !state.detail) return;
    const url = safeUrl(anchor.getAttribute('href'), state.detail.url);
    if (url) void api.openLink({ url }).catch(reportError);
  });
  articleContent.addEventListener('mouseup', () => requestAnimationFrame(showSelectionBar));
  articleContent.addEventListener('keyup', event => {
    if (['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) requestAnimationFrame(showSelectionBar);
  });
  const getSelectionOffsets = range => {
    const before = document.createRange();
    before.selectNodeContents(articleContent);
    before.setEnd(range.startContainer, range.startOffset);
    const raw = range.toString();
    const quote = raw.trim();
    const leading = raw.length - raw.trimStart().length;
    const start = before.toString().length + leading;
    const end = start + quote.length;
    if (!quote || String(state.detail?.textContent || '').slice(start, end) !== quote) return { quote, start: undefined, end: undefined };
    return { quote, start, end };
  };
  selectionBar.addEventListener('mousedown', event => event.preventDefault());
  selectionBar.addEventListener('click', async event => {
    const actionButton = event.target.closest('[data-selection-action]');
    if (!actionButton || !state.detail || !selectionRange) return;
    const quote = selectionRange.toString().trim();
    if (!quote) return;
    const { start, end } = getSelectionOffsets(selectionRange);
    try {
      if (actionButton.dataset.selectionAction === 'translate') {
        const result = await api.translate({ text: quote });
        showNotice(result?.text || '翻译完成。');
      } else {
        const id = state.detail.id;
        const note = actionButton.dataset.selectionAction === 'note' ? await requestArticleNote() : '';
        if (actionButton.dataset.selectionAction === 'note' && note === null) return;
        const result = await api.highlight({ id, quote, ...(Number.isInteger(start) && Number.isInteger(end) ? { start, end } : {}), note: note || '' });
        if (state.detail?.id === id && result?.id) {
          const scrollTop = articleScroll.scrollTop;
          state.detail.annotations = [...(state.detail.annotations || []), result];
          articleContent.replaceChildren(safeArticleFragment(state.detail.contentHtml || '', state.detail.url));
          renderAnnotations(state.detail);
          articleScroll.scrollTop = scrollTop;
        }
        showNotice(result?.noteError ? '高亮已保存，追加工作台笔记时出错。' + result.noteError : actionButton.dataset.selectionAction === 'note' ? '批注已保存到工作台笔记。' : '已保存高亮。');
      }
    } catch (error) { reportError(error); }
    finally { selectionBar.hidden = true; }
  });

  panel.addEventListener('keydown', async event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName));
    if (editing || selectedText() || !state.detail || !['e', 'E', 'l', 'L'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = state.rows.findIndex(row => row.id === state.detail.id);
    const next = state.rows[currentIndex + 1] || state.rows[currentIndex - 1];
    try {
      const status = event.key.toLowerCase() === 'e' ? 'archive' : 'later';
      await api.update({ id: state.detail.id, status });
      showNotice(status === 'archive' ? '已归档，正在打开下一篇。' : '已加入稍后深读，正在打开下一篇。');
      state.selectedId = next?.id || '';
      await load();
      if (state.selectedId) articleContent.focus({ preventScroll: true });
    } catch (error) { reportError(error); }
  });

  updateStatusNav();
  return { load };
}
