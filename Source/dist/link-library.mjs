import { mountLinkOrganization } from './link-organization.mjs';

const separators = /[,，、\n]+/;

function parseTags(value) {
  return [...new Set(String(value).split(separators).map(tag => tag.trim()).filter(Boolean))];
}

function matchesQuery(item, query) {
  if (!query) return true;
  const haystack = [item.url, item.title, item.note, ...(item.tags ?? [])].join('\n').toLocaleLowerCase('zh-CN');
  return haystack.includes(query.toLocaleLowerCase('zh-CN'));
}

export function setupLinkLibrary(panel, {
  api,
  node,
  action,
  tagsNode,
  heading,
  countLabel,
  empty,
  formMessage,
  errorText,
  debounce,
  notify,
  selectAnchor,
  setupNotes,
  addMarkdownTemplatePicker,
  createSourceIdea,
  show,
  names,
  getMain,
  lifeApi,
}) {
  panel.innerHTML = `<div class="wb-link-library" data-link-overview>
    ${heading('链接库', '按分区整理值得再读的网页。')}
    <div class="wb-link-library__layout">
      <aside class="wb-panel wb-link-library__sidebar" aria-label="链接分区">
        <div class="wb-section-heading"><h2>分区</h2></div>
        <nav class="wb-link-library__sections" data-link-sections></nav>
      </aside>
      <section class="wb-panel wb-link-library__content">
        <div class="wb-section-heading"><h2 data-link-section-title>全部</h2><div class="wb-inline-actions"><span class="wb-result" data-link-count></span><button class="wb-button" type="button" data-link-reload>刷新</button><button class="wb-button" type="button" data-link-new>新建链接</button></div></div>
        <div class="wb-link-library__tabs-row"><div class="wb-link-library__tabs" data-link-tabs role="tablist" aria-label="已打开的分区"></div><div class="wb-link-library__add-wrap"><button class="wb-button wb-subtle" data-link-add-tab type="button" aria-expanded="false" aria-label="打开一个分区">＋</button><div class="wb-link-library__chooser" data-link-chooser hidden></div></div></div>
        <input class="wb-search" data-link-search type="search" aria-label="搜索链接" placeholder="搜索网址、标题、标签或备注">
        <div class="wb-list wb-link-library__list" data-link-list></div>
      </section>
    </div>
  </div>
  <dialog class="wb-link-dialog" data-link-dialog aria-labelledby="wb-link-dialog-title">
    <form class="wb-form" data-link-form>
      <div class="wb-section-heading"><h2 id="wb-link-dialog-title" data-link-editor>新建链接</h2><button class="wb-button wb-subtle" type="button" data-link-cancel>关闭</button></div>
      <label>网址<input name="url" required placeholder="https://…" autocomplete="off" spellcheck="false"></label>
      <label>标题<input name="title" placeholder="可稍后补充"></label>
      <label>标签<input name="tags" placeholder="用逗号分隔多个标签"></label>
      <label>备注<textarea name="note" rows="5" placeholder="记下为什么值得读"></textarea></label>
      <label class="wb-check"><input type="checkbox" name="readLater"> 稍后读</label>
      <div class="wb-form-footer"><span class="wb-result" data-link-message role="status"></span><button type="button" class="wb-button" data-link-idea hidden>我的想法</button><button type="button" class="wb-button" data-risk-snapshot hidden>保存正文快照</button><button type="submit" class="wb-button wb-primary">保存链接　Ctrl+S</button></div>
    </form>
  </dialog>
  <section data-link-notes hidden>
    <header class="wb-reader-heading wb-link-notes-toolbar"><button class="wb-button" type="button" data-link-note-back>返回链接库</button><h1 data-link-notes-title></h1><button class="wb-button" type="button" data-link-handoff>复制 AI 镜像任务说明</button><button class="wb-button" type="button" data-link-note-folder>打开笔记目录</button><button class="wb-button" type="button" data-link-note-refresh>刷新笔记</button></header>
    <div data-link-workspace></div>
  </section>`;

  const $ = selector => panel.querySelector(selector);
  const form = $('[data-link-form]');
  const fields = form.elements;
  const dialog = $('[data-link-dialog]');
  const editor = $('[data-link-editor]');
  const message = $('[data-link-message]');
  const results = $('[data-link-list]');
  const count = $('[data-link-count]');
  const search = $('[data-link-search]');
  const sectionNav = $('[data-link-sections]');
  const tabStrip = $('[data-link-tabs]');
  const chooser = $('[data-link-chooser]');
  const linkNotes = $('[data-link-notes]');
  const linkOverview = $('[data-link-overview]');
  const noteMount = $('[data-link-workspace]');
  const idea = $('[data-link-idea]');
  const linkOrganization = mountLinkOrganization({
    panel,
    api: window.stilltimeDesktop.links,
    notify,
    refresh: () => load(),
  });
  addMarkdownTemplatePicker(fields.note, lifeApi, error => notify(errorText(error), true));

  const linkWorkspaces = new Map();
  const queryBySection = new Map();
  const scrollBySection = new Map();
  let activeLinkWorkspace;
  let allItems = [];
  let sectionTags = [];
  let selected;
  let activeNotesLink;
  let activeSection = 'all';
  let openSections = ['all'];
  let dirty = false;
  let saving = false;
  let request = 0;

  const fixedSections = [
    { id: 'all', name: '全部' },
    { id: 'inbox', name: '待整理' },
    { id: 'later', name: '稍后读' },
  ];
  const sectionName = id => fixedSections.find(section => section.id === id)?.name || (id.startsWith('tag:') ? id.slice(4) : id);
  const allSections = () => [...fixedSections, ...sectionTags.map(tag => ({ id: `tag:${tag}`, name: tag, tag }))];

  function leaveNotes() {
    linkNotes.hidden = true;
    linkOverview.hidden = false;
    const location = document.getElementById('wb-location');
    if (location) location.textContent = '链接库';
  }

  async function showNotes(link, name, anchor) {
    activeNotesLink = link;
    show('links', { load: false });
    if (!linkWorkspaces.has(link.id)) {
      const mount = node('section');
      noteMount.append(mount);
      linkWorkspaces.set(link.id, { mount, workspace: setupNotes(mount, { linkId: link.id, linkApi: api }) });
    }
    activeLinkWorkspace = linkWorkspaces.get(link.id);
    for (const entry of linkWorkspaces.values()) entry.mount.hidden = entry !== activeLinkWorkspace;
    $('[data-link-notes-title]').textContent = link.title || link.url;
    linkNotes.hidden = false;
    linkOverview.hidden = true;
    const location = document.getElementById('wb-location');
    if (location) location.textContent = '链接笔记';
    getMain()?.scrollTo({ top: 0 });
    if (name) return activeLinkWorkspace.workspace.openResult(name, 'link-note', anchor);
    await activeLinkWorkspace.workspace.load();
    return true;
  }

  function renderSections() {
    const sections = allSections();
    sectionNav.replaceChildren(...sections.map(section => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wb-link-library__section';
      button.textContent = section.name;
      button.setAttribute('aria-current', String(section.id === activeSection));
      button.onclick = () => openSection(section.id);
      return button;
    }));
    chooser.replaceChildren(...sections.filter(section => !openSections.includes(section.id)).map(section => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wb-link-library__chooser-item';
      button.textContent = section.name;
      button.onclick = () => { chooser.hidden = true; $('[data-link-add-tab]').setAttribute('aria-expanded', 'false'); openSection(section.id); };
      return button;
    }));
    if (!chooser.children.length) {
      const note = document.createElement('p');
      note.textContent = '所有分区都已打开';
      chooser.append(note);
    }
    renderTabs();
  }

  function renderTabs() {
    tabStrip.replaceChildren(...openSections.map(id => {
      const tab = document.createElement('div');
      tab.className = 'wb-link-library__tab';
      tab.setAttribute('role', 'presentation');
      const select = document.createElement('button');
      select.type = 'button';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(id === activeSection));
      select.textContent = sectionName(id);
      select.onclick = () => activateSection(id);
      tab.append(select);
      if (openSections.length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wb-link-library__tab-close';
        close.setAttribute('aria-label', `关闭${sectionName(id)}分区标签`);
        close.textContent = '×';
        close.onclick = () => closeSection(id);
        tab.append(close);
      }
      return tab;
    }));
  }

  function activateSection(id) {
    queryBySection.set(activeSection, search.value);
    scrollBySection.set(activeSection, results.scrollTop);
    activeSection = id;
    search.value = queryBySection.get(id) ?? '';
    $('[data-link-section-title]').textContent = sectionName(id);
    renderSections();
    render(allItems);
    results.scrollTop = scrollBySection.get(id) ?? 0;
  }

  function openSection(id) {
    if (!openSections.includes(id)) openSections.push(id);
    activateSection(id);
  }

  function closeSection(id) {
    if (id === activeSection) queryBySection.set(id, search.value);
    openSections = openSections.filter(value => value !== id);
    if (!openSections.length) openSections = ['all'];
    if (!openSections.includes(activeSection)) activeSection = openSections[Math.min(openSections.length - 1, openSections.indexOf(id))] || openSections[0];
    activateSection(activeSection);
  }

  function sectionItems(items) {
    return items.filter(item => {
      if (activeSection === 'inbox') return item.status === 'inbox';
      if (activeSection === 'later') return item.readLater === true;
      if (activeSection.startsWith('tag:')) return (item.tags ?? []).some(tag => tag.toLocaleLowerCase('zh-CN') === activeSection.slice(4).toLocaleLowerCase('zh-CN'));
      return true;
    }).filter(item => matchesQuery(item, search.value));
  }

  function edit(item, force = false) {
    if (saving || (!force && dirty && !confirm('放弃尚未保存的链接修改？'))) return false;
    selected = item;
    const snapshotButton = $('[data-risk-snapshot]');
    snapshotButton.dataset.riskSnapshot = item?.id ?? '';
    snapshotButton.hidden = !item;
    idea.hidden = !item;
    form.reset();
    if (item) {
      for (const name of ['url', 'title', 'note']) fields[name].value = item[name] ?? '';
      fields.tags.value = (item.tags ?? []).join('，');
      fields.readLater.checked = item.readLater === true;
    }
    dirty = false;
    editor.textContent = item ? '编辑链接' : '新建链接';
    formMessage(message, '');
    if (!dialog.open) dialog.showModal();
    (item ? fields.title : fields.url).focus();
    return true;
  }

  function render(items) {
    const shown = sectionItems(items);
    linkOrganization.setVisibleItems(shown);
    count.textContent = countLabel(shown.length);
    if (!shown.length) {
      empty(results, search.value ? '没有找到匹配的链接。' : '这个分区还没有链接。');
      return;
    }
    results.replaceChildren(...shown.map(item => {
      const entry = node('article', 'wb-link-row');
      const url = node('button', 'wb-link-row__url', item.url);
      url.type = 'button';
      url.title = item.url;
      url.onclick = () => edit(item);
      const identity = node('div', 'wb-link-row__identity');
      const title = node('button', 'wb-link-row__title', item.title || '未命名链接');
      title.type = 'button';
      title.onclick = () => edit(item);
      const note = node('span', 'wb-link-row__note', item.note || '');
      identity.append(url, title, note);
      const state = node('div', 'wb-link-row__state');
      if (item.status === 'inbox') state.append(node('span', 'wb-state', '待整理'));
      if (item.readLater) state.append(node('span', 'wb-state wb-state-later', '稍后读'));
      if (item.isPrimary) state.append(node('span', 'wb-state wb-state-primary', '主要记录'));
      if (item.duplicateCount > 1 && !item.isPrimary) state.append(node('span', 'wb-state wb-state-duplicate', `重复组 · ${item.duplicateCount} 条`));
      const buttons = node('div', 'wb-link-row__actions');
      buttons.append(
        action('复制网址', () => api.copyLink(item.url).then(() => notify('已复制网址'), error => notify(errorText(error), true))),
        action('链接笔记', () => void showNotes(item).catch(error => notify(errorText(error), true))),
        action('打开', () => api.openLink(item.url).catch(error => notify(errorText(error), true)), 'wb-button', 'arrowUpRight'),
      );
      const selection = linkOrganization.selectionControl(item);
      selection.classList.add('wb-link-row__select');
      entry.append(selection, url, identity, tagsNode(item.tags), state, buttons);
      return entry;
    }));
  }

  async function load({ refreshOrganization = true } = {}) {
    const token = ++request;
    try {
      const [items, organization] = await Promise.all([
        api.listLinks(''),
        refreshOrganization ? linkOrganization.refreshData() : linkOrganization.getOrganizationData(),
      ]);
      const duplicateById = new Map();
      for (const group of organization.duplicateGroups) {
        for (const item of group.items) duplicateById.set(item.id, { isPrimary: item.id === group.primaryId, duplicateCount: group.items.length });
      }
      if (token !== request) return;
      sectionTags = organization.tags.map(tag => tag.name);
      const tagSections = sectionTags.map(tag => `tag:${tag}`);
      for (const id of [...openSections]) if (id.startsWith('tag:') && !tagSections.includes(id)) openSections = openSections.filter(value => value !== id);
      if (!openSections.length) openSections = ['all'];
      if (!openSections.includes(activeSection)) activeSection = openSections[0];
      allItems = items.map(item => ({ ...item, ...(duplicateById.get(item.id) || {}) }));
      renderSections();
      render(allItems);
      linkOrganization.setUndoAvailable(organization.canUndo);
    } catch (error) {
      if (token === request) empty(results, errorText(error));
    }
  }

  search.oninput = debounce(() => {
    queryBySection.set(activeSection, search.value);
    render(allItems);
  });
  results.addEventListener('scroll', () => scrollBySection.set(activeSection, results.scrollTop), { passive: true });
  $('[data-link-reload]').onclick = () => void load();
  $('[data-link-add-tab]').onclick = event => {
    chooser.hidden = !chooser.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!chooser.hidden));
  };
  $('[data-link-new]').onclick = () => edit(null);
  $('[data-link-note-back]').onclick = leaveNotes;
  $('[data-link-note-refresh]').onclick = () => void activeLinkWorkspace?.workspace.load();
  $('[data-link-note-folder]').onclick = () => {
    if (activeNotesLink) api.revealLinkNotes(activeNotesLink.id).catch(error => notify(errorText(error), true));
  };
  $('[data-link-handoff]').onclick = () => {
    if (activeNotesLink) api.copyLinkHandoff(activeNotesLink.id).then(() => notify('已复制 AI 镜像任务说明。'), error => notify(errorText(error), true));
  };
  $('[data-link-cancel]').onclick = () => {
    if (saving || dirty && !confirm('放弃尚未保存的链接修改？')) return;
    dirty = false;
    dialog.close();
  };
  dialog.addEventListener('cancel', event => {
    if (saving || dirty && !confirm('放弃尚未保存的链接修改？')) event.preventDefault();
    else dirty = false;
  });
  $('[data-link-idea]').onclick = () => {
    if (selected) void createSourceIdea({ type: 'link', linkId: selected.id, url: selected.url, title: selected.title });
  };
  fields.url.addEventListener('paste', event => {
    const pasted = event.clipboardData?.getData('text').trim();
    if (!pasted) return;
    try {
      const url = new URL(pasted);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s/.test(pasted)) return;
      event.preventDefault();
      fields.url.value = pasted;
      dirty = true;
      formMessage(message, '有未保存的修改');
    } catch { /* Keep the pasted text editable when it is not a URL. */ }
  });
  form.oninput = () => {
    dirty = true;
    formMessage(message, '有未保存的修改');
  };
  form.onkeydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      form.requestSubmit();
    }
  };
  async function saveLink() {
    if (saving) return;
    if (!form.reportValidity()) {
      if (!dialog.open) dialog.showModal();
      fields.url.focus();
      return false;
    }
    saving = true;
    const submit = form.querySelector('[type=submit]');
    for (const field of form.elements) field.disabled = true;
    formMessage(message, '正在保存…');
    try {
      const result = await api.saveLink({
        id: selected?.id,
        url: fields.url.value.trim(),
        title: fields.title.value.trim(),
        tags: parseTags(fields.tags.value),
        note: fields.note.value,
        readLater: fields.readLater.checked,
      });
      if (result.duplicate) {
        formMessage(message, '此网址已收藏。', true);
        if (result.item) {
          const open = action('查看原记录', () => { dirty = false; dialog.close(); edit(result.item, true); void load(); });
          message.append(' ', open);
        }
      } else {
        dirty = false;
        formMessage(message, '已保存');
        dialog.close();
        selected = result.item;
        notify('已保存链接');
        await load();
        return true;
      }
    } catch (error) { formMessage(message, errorText(error), true); }
    finally {
      saving = false;
      for (const field of form.elements) field.disabled = false;
      submit.disabled = false;
    }
    return false;
  }
  form.onsubmit = event => { event.preventDefault(); void saveLink(); };

  async function openSource(id, { name, anchor } = {}) {
    const item = allItems.find(link => link.id === id) || (await api.listLinks('')).find(link => link.id === id);
    if (!item) { notify('链接库中找不到原记录。', true); return false; }
    if (name) return showNotes(item, name, anchor);
    search.value = '';
    queryBySection.set(activeSection, '');
    activateSection('all');
    show('links');
    leaveNotes();
    if (!edit(item)) return false;
    editor.scrollIntoView({ block: 'nearest' });
    if (!selectAnchor(fields.note, anchor)) selectAnchor(fields.title, anchor);
    return true;
  }

  function pending() {
    const entries = [];
    if (dirty) entries.push({
      key: 'link-editor',
      title: fields.title.value.trim() || fields.url.value.trim() || '新建链接',
      location: '链接库',
      activate: () => {
        if (!dialog.open) dialog.showModal();
        fields.url.focus();
      },
      save: saveLink,
    });
    for (const [linkId, entry] of linkWorkspaces) {
      for (const pendingEntry of entry.workspace.pending?.() ?? []) {
        entries.push({
          ...pendingEntry,
          key: `link-note:${linkId}:${pendingEntry.key}`,
          location: '链接笔记',
          activate: async () => {
            const link = allItems.find(item => item.id === linkId) || (await api.listLinks('')).find(item => item.id === linkId);
            if (link) await showNotes(link);
            await pendingEntry.activate?.();
          },
        });
      }
    }
    return entries;
  }

  renderSections();
  return {
    load: () => linkNotes.hidden ? load() : activeLinkWorkspace.workspace.load(),
    location: () => linkNotes.hidden ? names.links : '链接笔记',
    requestSave: () => {
      if (dirty) {
        if (!dialog.open) dialog.showModal();
        fields.url.focus();
        return Promise.resolve(true);
      }
      return !linkNotes.hidden && activeLinkWorkspace?.workspace.requestSave();
    },
    isDirty: () => dirty || [...linkWorkspaces.values()].some(entry => entry.workspace.isDirty()),
    pending,
    openSource,
  };
}
