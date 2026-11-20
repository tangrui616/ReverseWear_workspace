import { setupInspirationBoard } from './inspiration-board.mjs';
import { setupIdeaKanban } from './idea-kanban.mjs';
import { addMarkdownTemplatePicker } from './markdown-templates.mjs';
import { setMarkdownContent, handleMarkdownLink } from './markdown-renderer.mjs';

const pageSize = 40;
const areas = {
  unclassified: '未分类', research: '研究', content: '内容创作',
  language: '语言', life: '生活', emotion: '情绪',
};
const statuses = { seed: '种子', growing: '培养中', action: '行动', done: '完成', fridge: '冰箱', archived: '归档' };
const options = (items, all) => (all ? '<option value="">' + all + '</option>' : '')
  + Object.entries(items).map(([id, name]) => '<option value="' + id + '">' + name + '</option>').join('');

export function setupIdeas(panel, { api, getWorkDate, notice, errorText, openSource, openTools, getPreferences, selectAnchor, createTopic }) {
  panel.innerHTML = `
    <header class="wb-heading wb-ideas-heading">
      <div><h1>灵感</h1><p>记录当时的原话，日后再分类、补充或付诸行动。</p></div>
      <div class="wb-inline-actions">
        <button type="button" class="wb-button" data-capture-settings>快捷键设置</button>
        <button type="button" class="wb-button wb-primary" data-quick-capture>快速记录</button>
      </div>
    </header>
    <div class="wb-filters" aria-label="灵感视图">
      <button type="button" data-idea-tab="inbox" aria-pressed="true">收件箱</button>
      <button type="button" data-idea-tab="cards" aria-pressed="false">灵感卡片</button>
      <button type="button" data-idea-tab="kanban" aria-pressed="false">想法看板</button>
      <button type="button" data-idea-tab="board" aria-pressed="false">灵感板</button>
    </div>
    <section class="wb-panel wb-inbox" data-idea-pane="inbox">
      <div class="wb-section-heading"><h2>收件箱</h2><span class="wb-result" data-inbox-count></span></div>
      <div class="wb-inline-actions wb-idea-filters">
        <label>归档日期 <input type="date" data-inbox-date></label>
        <button class="wb-button" type="button" data-inbox-today>今天</button>
        <button class="wb-button" type="button" data-inbox-refresh>刷新</button>
      </div>
      <div class="wb-list" data-inbox-list></div>
    </section>
    <div class="wb-columns wb-idea-columns" data-idea-pane="cards" hidden>
      <section class="wb-panel">
        <div class="wb-section-heading"><h2>灵感卡片</h2><span class="wb-result" data-idea-count></span></div>
        <input class="wb-search" data-idea-search type="search" aria-label="搜索灵感" placeholder="搜索标题、原话或标签">
        <div class="wb-idea-filters wb-inline-actions">
          <select aria-label="按领域筛选" data-idea-area>${options(areas, '全部领域')}</select>
          <select aria-label="按状态筛选" data-idea-status>${options(statuses, '全部状态')}</select>
          <input type="search" aria-label="按标签筛选" placeholder="筛选标签" data-idea-tag>
          <button class="wb-button" type="button" data-idea-refresh>刷新</button>
        </div>
        <div class="wb-list" data-idea-list></div>
        <div class="wb-inline-actions wb-idea-filters" data-idea-pages hidden>
          <button class="wb-button" type="button" data-idea-prev>上一页</button>
          <span class="wb-result" data-idea-page role="status"></span>
          <button class="wb-button" type="button" data-idea-next>下一页</button>
        </div>
      </section>
      <section class="wb-panel wb-idea-editor" aria-labelledby="wb-idea-editor-heading">
        <div class="wb-section-heading"><h2 id="wb-idea-editor-heading">灵感详情</h2></div>
        <p class="wb-empty" data-idea-placeholder>选择一张卡片，查看原话和后续想法。</p>
        <form class="wb-form" data-idea-edit hidden>
          <label>标题<input name="title" maxlength="160"></label>
          <div class="wb-idea-filters">
            <label>领域<select name="area">${options(areas)}</select></label>
            <label>状态<select name="status">${options(statuses)}</select></label>
          </div>
          <label>标签<input name="tags" placeholder="用逗号分隔多个标签"></label>
          <div><strong>原话</strong><div class="wb-idea-text markdown-content" data-idea-original></div></div>
          <div data-idea-source-box hidden>
            <strong>来源</strong><div class="wb-idea-text markdown-content" data-idea-source></div>
            <blockquote class="wb-idea-text markdown-content" data-idea-quote hidden></blockquote>
            <button class="wb-button" type="button" data-idea-open-source>回到来源</button>
          </div>
          <label>我的后续想法<textarea name="followup" rows="5"></textarea></label>
          <div data-idea-ai-box hidden><strong>AI 整理</strong><div class="wb-idea-text markdown-content" data-idea-ai></div></div>
          <label class="wb-check"><input type="checkbox" name="private"> 私密</label>
          <div class="wb-form-footer">
            <span role="status" class="wb-result" data-idea-message></span>
            ${createTopic ? '<button type="button" class="wb-button" data-idea-topic>转为创作选题</button>' : ''}
            <button type="button" class="wb-button" data-idea-mirror>AI 审核与镜像</button>
            <button type="submit" class="wb-button wb-primary">保存卡片</button>
          </div>
        </form>
      </section>
    </div>
    <section class="wb-panel" data-idea-pane="kanban" hidden></section>
    <section data-idea-pane="board" hidden></section>
    <dialog class="wb-idea-dialog" data-capture-dialog aria-labelledby="wb-capture-heading">
      <form class="wb-form">
        <h2 id="wb-capture-heading">快速记录快捷键</h2>
        <label>组合键<input name="accelerator" placeholder="Ctrl+Alt+I" spellcheck="false" autocomplete="off" required></label>
        <small>工作台打开期间可在其他应用中使用。占用时仍可点击「快速记录」。</small>
        <div class="wb-form-footer">
          <span class="wb-result" data-shortcut-message role="status"></span>
          <button type="button" class="wb-button" data-shortcut-close>关闭</button>
          <button type="submit" class="wb-button wb-primary">保存</button>
        </div>
      </form>
    </dialog>`;
  const $ = selector => panel.querySelector(selector);
  const list = $('[data-idea-list]');
  const inbox = $('[data-inbox-list]');
  const form = $('[data-idea-edit]');
  const fields = form.elements;
  addMarkdownTemplatePicker(fields.followup, window.stilltimeDesktop.life, error => notice(errorText(error), true));
  const date = $('[data-inbox-date]');
  const shortcut = $('[data-capture-dialog]');
  const shortcutField = shortcut.querySelector('input');
  const shortcutMessage = $('[data-shortcut-message]');
  const tabButtons = [...panel.querySelectorAll('[data-idea-tab]')];
  const panes = [...panel.querySelectorAll('[data-idea-pane]')];
  const board = setupInspirationBoard($('[data-idea-pane="board"]'), { api: window.stilltimeDesktop, notice, errorText, selectAnchor });
  panel.addEventListener('click', event => handleMarkdownLink(event, {
    openLink: url => window.stilltimeDesktop.workbench.openLink(url),
    onError: error => notice(errorText(error), true),
  }));
  const kanban = setupIdeaKanban($('[data-idea-pane="kanban"]'), {
    api, notice, errorText, getPreferences,
    onOpen: id => openResult({ id, type: 'idea' }),
    onIndexChanged: listener => window.stilltimeDesktop.onIndexChanged(listener),
  });
  let view = 'inbox', day = getWorkDate(), selected, dirty = false, saving = false, generation = 0;
  let filterTimer, page = 0;
  date.value = day;
  const unsubscribe = window.stilltimeDesktop.onIndexChanged(categories => {
    if (panel.hidden || view === 'inbox') return;
    if ((view === 'cards' && categories.includes('ideas')) || (view === 'kanban' && categories.includes('ideas')) || (view === 'board' && categories.includes('inspirationboard'))) void load();
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });

  function el(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = content;
    return element;
  }
  function button(label, handler, className = 'wb-button') {
    const element = el('button', className, label);
    element.type = 'button';
    element.onclick = handler;
    return element;
  }
  const setMessage = (text, failed = false) => {
    const message = $('[data-idea-message]');
    message.textContent = text;
    message.classList.toggle('wb-error', failed);
  };
  function sourceText(source) {
    if (typeof source === 'string') return source;
    if (source?.type === 'pdf') return (source.fileName || 'PDF') + ' · 第 ' + source.page + ' 页';
    return source?.title || source?.url || '';
  }
  function edit(item) {
    selected = item;
    form.hidden = !item;
    $('[data-idea-placeholder]').hidden = Boolean(item);
    form.reset();
    if (item) {
      fields.title.value = item.title || '';
      fields.area.value = item.area || 'unclassified';
      fields.status.value = item.status || 'seed';
      fields.tags.value = (item.tags || []).join('，');
      fields.followup.value = item.followup || '';
      fields.private.checked = Boolean(item.private);
      fields.private.disabled = item.area === 'emotion';
      setMarkdownContent($('[data-idea-original]'), item.original);
      $('[data-idea-source-box]').hidden = !sourceText(item.source);
      setMarkdownContent($('[data-idea-source]'), sourceText(item.source));
      $('[data-idea-quote]').hidden = !item.source?.quote;
      setMarkdownContent($('[data-idea-quote]'), item.source?.quote ?? '');
      const ai = (item.aiBlock || '').replace(/^## AI 整理\s*(?:\n|$)/, '');
      $('[data-idea-ai-box]').hidden = !ai;
      setMarkdownContent($('[data-idea-ai]'), ai);
    }
    dirty = false;
    setMessage('');
  }
  const canSwitch = () => !saving && (!dirty || confirm('放弃尚未保存的灵感修改？'));

  async function renderInbox(token) {
    const [captures, cards] = await Promise.all([api.listCaptures({ date: date.value }), api.listIdeas()]);
    if (token !== generation) return;
    const linked = new Map(cards.filter(item => item.captureId).map(item => [item.captureId, item]));
    $('[data-inbox-count]').textContent = captures.length + ' 条';
    inbox.replaceChildren(...captures.map(item => {
      const entry = el('article', 'wb-entry');
      const title = el('div', 'wb-idea-text markdown-content');
      setMarkdownContent(title, item.text);
      const moment = new Date(item.createdAt);
      const meta = el('p', 'wb-date', moment.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      const source = sourceText(item.source);
      const existing = linked.get(item.id);
      const actions = el('div', 'wb-entry-actions');
      const convert = button(existing ? '打开卡片' : '转为灵感卡片', async () => {
        if (!canSwitch()) return;
        convert.disabled = true;
        try {
          const card = existing ?? (await api.createIdea({ captureId: item.id, captureDate: item.date })).item;
          await reveal(card);
          if (!existing) notice('已转为灵感卡片');
        } catch (error) { notice(errorText(error), true); }
        finally { convert.disabled = false; }
      });
      convert.dataset.captureConvert = item.id;
      actions.append(convert);
      entry.append(title, meta);
      if (source) entry.append(el('p', 'wb-url', source));
      entry.append(actions);
      return entry;
    }));
    if (!captures.length) inbox.append(el('p', 'wb-empty', '这一天还没有记录。'));
  }

  async function renderCards(token) {
    const query = $('[data-idea-search]').value;
    const area = $('[data-idea-area]').value;
    const status = $('[data-idea-status]').value;
    const tag = $('[data-idea-tag]').value;
    const { items, total } = await api.listIdeas({ query, area, status, tag, offset: page * pageSize, limit: pageSize });
    if (token !== generation) return;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page >= pages) {
      page = pages - 1;
      return renderCards(token);
    }
    $('[data-idea-count]').textContent = total + ' 张';
    $('[data-idea-pages]').hidden = pages <= 1;
    $('[data-idea-page]').textContent = `${page + 1} / ${pages}`;
    $('[data-idea-prev]').disabled = page === 0;
    $('[data-idea-next]').disabled = page + 1 >= pages;
    list.replaceChildren(...items.map(item => {
      const entry = el('article', 'wb-entry');
      const head = el('div', 'wb-entry-head');
      const title = button(item.title || item.original, () => {
        if (item.id === selected?.id || !canSwitch()) return;
        edit(item);
        void load();
      }, 'wb-entry-title');
      title.dataset.ideaCard = item.id;
      if (selected?.id === item.id) title.setAttribute('aria-current', 'true');
      head.append(title, el('span', 'wb-state', statuses[item.status] || statuses.seed));
      const tags = el('div', 'wb-tags');
      for (const label of item.tags || []) tags.append(el('span', 'wb-tag', label));
      const meta = [areas[item.area], item.private && '私密', sourceText(item.source)].filter(Boolean).join(' · ');
      const excerpt = el('div', 'wb-excerpt markdown-content');
      setMarkdownContent(excerpt, item.original, { inline: true });
      entry.append(head, el('p', 'wb-date', meta), excerpt, tags);
      return entry;
    }));
    if (!items.length) list.append(el('p', 'wb-empty', '没有匹配的灵感卡片。'));
  }

  function selectTab(next) {
    view = next;
    for (const control of tabButtons) control.setAttribute('aria-pressed', String(control.dataset.ideaTab === next));
    for (const pane of panes) pane.hidden = pane.dataset.ideaPane !== next;
  }
  async function load() {
    const workDate = getWorkDate();
    if (date.value === day) date.value = workDate;
    day = workDate;
    const token = ++generation;
    try {
      if (view === 'inbox') await renderInbox(token);
      else if (view === 'board') await board.load();
      else if (view === 'kanban') await kanban.load();
      else await renderCards(token);
    } catch (error) {
      if (token === generation) (view === 'inbox' ? inbox : list).replaceChildren(el('p', 'wb-empty', errorText(error)));
    }
  }
  async function reveal(item) {
    edit(item);
    selectTab('cards');
    page = 0;
    $('[data-idea-search]').value = '';
    $('[data-idea-area]').value = '';
    $('[data-idea-status]').value = '';
    $('[data-idea-tag]').value = '';
    await load();
    fields.title.focus();
  }
  async function openResult(result) {
    if (result?.type === 'inspiration-board') {
      selectTab('board');
      await load();
      return board.openResult(result);
    }
    const item = (await api.listIdeas()).find(card => card.id === result?.id);
    if (!item) throw new Error('找不到这条灵感记录。');
    if (dirty && selected?.id !== item.id && !confirm('放弃尚未保存的灵感修改？')) return false;
    if (!(dirty && selected?.id === item.id)) await reveal(item);
    if (result.anchor) [fields.followup, fields.title, fields.sourceNote, $('[data-idea-original]'), $('[data-idea-ai]')]
      .some(field => selectAnchor?.(field, result.anchor));
    return true;
  }
  tabButtons.forEach(control => control.onclick = () => { selectTab(control.dataset.ideaTab); void load(); });
  date.onchange = () => { if (date.value) void load(); };
  $('[data-inbox-today]').onclick = () => { date.value = getWorkDate(); void load(); };
  $('[data-idea-prev]').onclick = () => { page--; void load(); };
  $('[data-idea-next]').onclick = () => { page++; void load(); };
  for (const selector of ['[data-inbox-refresh]', '[data-idea-refresh]']) $(selector).onclick = load;
  for (const selector of ['[data-idea-area]', '[data-idea-status]']) $(selector).onchange = () => { page = 0; void load(); };
  for (const selector of ['[data-idea-search]', '[data-idea-tag]']) $(selector).oninput = () => {
    clearTimeout(filterTimer);
    page = 0;
    filterTimer = setTimeout(load, 65);
  };
  $('[data-quick-capture]').onclick = () => api.openQuickCapture().catch(error => notice(errorText(error), true));
  $('[data-idea-open-source]').onclick = () => selected && openSource(selected.source);
  if (createTopic) $('[data-idea-topic]').onclick = () => {
    if (!selected) return;
    const body = [selected.original, fields.followup.value, `来源灵感 [[${selected.id}]]`].filter(Boolean).join('\n\n');
    void createTopic({ title: fields.title.value || '未命名选题', body, area: areas[fields.area.value] || '', private: selected.private || fields.private.checked })
      .catch(error => notice(errorText(error), true));
  };
  $('[data-idea-mirror]').onclick = () => openTools('mirror');
  form.oninput = event => {
    if (event.target === fields.area) {
      fields.private.disabled = fields.area.value === 'emotion';
      if (fields.private.disabled) fields.private.checked = true;
    }
    dirty = true;
  };
  async function saveCurrentIdea() {
    if (!selected || saving) return false;
    if (!form.reportValidity()) return false;
    const nextStatus = fields.status.value;
    if (nextStatus === 'action' && selected.status !== 'action' && getPreferences?.().warnActionLimit !== false) {
      const active = await api.listIdeas({ status: 'action' });
      if (active.filter(item => item.id !== selected.id).length >= 3 && !confirm('行动中的想法将超过 3 个，仍要继续吗？')) return;
    }
    saving = true;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const result = await api.saveIdea({
        id: selected.id, expectedUpdatedAt: selected.updatedAt, title: fields.title.value,
        area: fields.area.value, status: fields.status.value, tags: fields.tags.value.split(/[,，、;；\n]+/).map(tag => tag.trim()).filter(Boolean),
        followup: fields.followup.value, private: fields.private.checked,
      });
      edit(result.item ?? result);
      setMessage(result.mirrorPrivacyStatus === 'pending' ? '已设为私密。Harness 完成后将撤回镜像副本。' : '已保存');
      void load();
      return !dirty;
    } catch (error) { setMessage(errorText(error), true); }
    finally { saving = false; submit.disabled = false; }
    return false;
  }
  form.onsubmit = async event => {
    event.preventDefault();
    await saveCurrentIdea();
  };
  $('[data-capture-settings]').onclick = async () => {
    if (shortcut.open) return;
    try {
      const settings = await api.captureShortcut();
      shortcutField.value = settings.accelerator;
      shortcutMessage.textContent = settings.registered ? '' : '当前快捷键未注册，可换一个组合键。';
      shortcut.showModal();
    } catch (error) { notice(errorText(error), true); }
  };
  $('[data-shortcut-close]').onclick = () => shortcut.close();
  shortcut.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const submit = shortcut.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const settings = await api.setCaptureShortcut(shortcutField.value);
      if (!settings.registered) throw new Error('组合键已被占用，请换一个。');
      shortcutField.value = settings.accelerator;
      shortcut.close();
      notice('已更新快速记录快捷键');
    } catch (error) { shortcutMessage.textContent = errorText(error); }
    finally { submit.disabled = false; }
  };
  return {
    load,
    openInbox: () => { date.value = getWorkDate(); selectTab('inbox'); void load(); },
    openResult,
    getPreferences,
    isDirty: () => dirty || board.isDirty(),
    pendingEntries() {
      const entries = [];
      if (dirty && selected) entries.push({
        key: `idea:${selected.id}`,
        label: `灵感 · ${fields.title.value.trim() || '未命名卡片'}`,
        focus() {
          selectTab('cards');
          void load().then(() => fields.title.focus());
        },
        save: saveCurrentIdea,
      });
      for (const entry of board.pendingEntries?.() || []) entries.push({
        ...entry,
        focus() {
          selectTab('board');
          void load().then(() => entry.focus());
        },
      });
      return entries;
    },
  };
}
