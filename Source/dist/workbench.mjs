import { mountOuroborosFrame } from './ouroboros-frame.mjs';
import { setupResearch } from './research.mjs';
import { createWorkbenchIcon, renderWorkbenchIcons } from './icons.mjs';
import { getWorkDate, setDayStartMinutes } from './date-boundary.mjs';
import { setupIdeas } from './ideas.mjs';
import { setupWebCollection } from './web-collection.mjs';
import { renderDocumentPreview, selectedDocumentText, setupDocumentReaderZoom } from './document-reader.mjs';
import { mountTagSuggestions } from './tag-suggestions.mjs';
import { setupWindowControls, setupQuitDialog } from './window-controls.mjs';
import { mountGlobalSearch } from './global-search.mjs';
import { setupWeeklyReview } from './weekly-review.mjs';
import { createTranslationPanel, createInlineTranslation } from './translation.mjs';
import { setupLifeWorkbench } from './life.mjs';
import { addMarkdownTemplatePicker } from './markdown-templates.mjs';
import { mountNoteWorkspace } from './note-workspace.mjs';
import { mountHomeTimer } from './home-timer.mjs';
import { mountHomeDashboard } from './home-dashboard.mjs';
import { mountHomeTranslation } from './home-translation.mjs';
import { setupClipboardPage } from './clipboard-page.mjs';
import { handleMarkdownLink } from './markdown-renderer.mjs';
import { createWorkbenchSettings } from './workbench-settings.mjs';
import { isStartupActive, markStartupWorkbenchReady, previewStartup, testStartupVoice } from './startup/entry.mjs';

const api = window.stilltimeDesktop.workbench;
const capture = window.stilltimeDesktop.capture;
const risk = window.stilltimeDesktop.risk;
const clipboard = { ...window.stilltimeDesktop.desktopSuite, invoke: window.stilltimeDesktop.desktopSuite.invokeClipboard };
const browserApi = window.stilltimeDesktop.articles.browser;
const preferences = await risk.preferences();
setDayStartMinutes(preferences.dayStartMinutes);
const $ = id => document.getElementById(id);
const names = { home: '今天', ideas: '灵感', weekly: '周复盘', links: '网页收藏', clipboard: '剪贴板', settings: '设置', notes: '笔记', experiments: '实验记录', plans: '备忘录', files: '上传文件', translation: '离线翻译', life: '生活与思考', focus: '专注计时' };

function selectAnchor(element, anchor) {
  if (!element || typeof anchor !== 'string' || !anchor.trim()) return false;
  const field = element.matches('textarea,input');
  const value = field ? element.value : element.textContent;
  if (field) anchor = anchor.replace(/\r\n/g, '\n');
  const offset = value.indexOf(anchor);
  if (offset < 0) return false;
  element.scrollIntoView({ block: 'nearest' });
  if (!field) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let position = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const end = position + node.length;
      if (!started && offset < end) {
        range.setStart(node, offset - position);
        started = true;
      }
      if (started && offset + anchor.length <= end) {
        range.setEnd(node, offset + anchor.length - position);
        break;
      }
      position = end;
    }
    if (!started) return false;
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const bounds = range.getBoundingClientRect();
    element.closest('.wb-main, .wb-risk-body')?.scrollBy({ top: bounds.top - element.getBoundingClientRect().top });
  } else {
    element.focus({ preventScroll: true });
    element.setSelectionRange(offset, offset + anchor.length);
    if (element.matches('textarea')) {
      const style = getComputedStyle(element);
      const measure = node('div');
      for (const property of ['font', 'lineHeight', 'letterSpacing', 'padding', 'whiteSpace', 'overflowWrap', 'tabSize']) measure.style[property] = style[property];
      Object.assign(measure.style, { position: 'fixed', visibility: 'hidden', boxSizing: 'border-box', width: element.clientWidth + 'px' });
      const mark = node('span', null, anchor);
      measure.append(value.slice(0, offset), mark);
      document.body.append(measure);
      element.scrollTop = Math.max(0, mark.offsetTop - element.clientHeight / 3);
      measure.remove();
    }
  }
  return true;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function action(text, callback, className = 'wb-button', iconName = '') {
  const button = node('button', className, text);
  button.type = 'button';
  if (iconName) {
    const icon = createWorkbenchIcon(iconName);
    if (icon) button.append(icon);
  }
  button.onclick = callback;
  return button;
}
function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function dateLabel(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '.');
  const date = new Date(value);
  return Number.isNaN(+date) ? '' : localDate(date).replaceAll('-', '.');
}
function tagsNode(tags = []) {
  const row = node('div', 'wb-tags');
  tags.forEach(tag => row.append(node('span', 'wb-tag', tag)));
  return row;
}
let noticeTimer;
function notice(text, error = false) {
  const element = $('wb-notice');
  element.textContent = text;
  element.classList.toggle('wb-error', error);
  element.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { element.hidden = true; }, error ? 7500 : 4200);
}
function errorText(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function empty(target, message) { target.replaceChildren(node('p', 'wb-empty', message)); }
function debounce(callback) {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(callback, 180); };
}
function heading(title, subtitle) {
  return '<header class="wb-heading"><div><h1>' + title + '</h1><p>' + subtitle + '</p></div></header>';
}
function formMessage(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle('wb-error', error);
}
function countLabel(count) { return count + ' 项'; }
function assign(panel, selector) { return panel.querySelector(selector); }

const ideaPrompt = document.createElement('dialog');
ideaPrompt.className = 'wb-idea-dialog';
ideaPrompt.setAttribute('aria-labelledby', 'wb-source-idea-title');
ideaPrompt.innerHTML = `
  <form class="wb-form">
    <h2 id="wb-source-idea-title">记一条想法</h2>
    <p class="wb-idea-text" data-source-name></p>
    <blockquote class="wb-idea-text" data-source-quote hidden></blockquote>
    <label>此刻的想法<textarea name="original" rows="3" required maxlength="4000" autofocus></textarea></label>
    <div class="wb-form-footer">
      <span class="wb-result" role="status" data-source-message></span>
      <button class="wb-button" type="button" data-source-cancel>取消</button>
      <button class="wb-button wb-primary" type="submit">保存灵感</button>
    </div>
  </form>`;
$('workbench').append(ideaPrompt);

function createSourceIdea(source) {
  if (ideaPrompt.open) return Promise.resolve(null);
  const form = ideaPrompt.querySelector('form');
  const submit = form.querySelector('[type=submit]');
  const cancel = form.querySelector('[data-source-cancel]');
  const message = form.querySelector('[data-source-message]');
  const quote = form.querySelector('[data-source-quote]');
  const name = form.querySelector('[data-source-name]');
  name.textContent = source.type === 'pdf'
    ? source.fileName + ' · 第 ' + source.page + ' 页'
    : source.title || source.url;
  quote.hidden = !source.quote;
  quote.textContent = source.quote ?? '';
  form.reset();
  formMessage(message, '');
  let result;
  return new Promise(resolve => {
    ideaPrompt.oncancel = event => { if (submit.disabled) event.preventDefault(); };
    ideaPrompt.onclose = () => { form.onsubmit = null; resolve(result ?? null); };
    cancel.onclick = () => ideaPrompt.close();
    form.onsubmit = async event => {
      event.preventDefault();
      const original = form.elements.original.value;
      if (submit.disabled || !original.trim()) return;
      submit.disabled = cancel.disabled = true;
      try {
        result = (await capture.createIdea({ original, source })).item;
        notice('已保存到灵感卡片');
        ideaPrompt.close();
      } catch (error) { formMessage(message, errorText(error), true); }
      finally { submit.disabled = cancel.disabled = false; }
    };
    ideaPrompt.showModal();
  });
}

function setupNotes(panel, options = {}) {
  return mountNoteWorkspace(panel, {
    api,
    selectAnchor,
    getWorkDate,
    showNotice: notice,
    onTranslate: openTranslation,
    onOpenFile: (fileId, page) => tabs.files.openSource({ fileId, page }),
    addTemplate: target => addMarkdownTemplatePicker(target, window.stilltimeDesktop.life, error => notice(errorText(error), true)),
    ...options,
  });
}

function noteEntries(workspace) {
  return workspace.pendingEntries().map(entry => ({
    ...entry,
    title: entry.label,
    focus: () => workspace.focusDraft(entry.key),
    activate: () => workspace.focusDraft(entry.key),
    save: () => workspace.saveDraft(entry.key),
  }));
}

function setupLinks(panel) {
  return setupWebCollection(panel, {
    api, browserApi, node, action, tagsNode, heading, countLabel, empty, formMessage, errorText,
    debounce, notify: notice, selectAnchor,
    setupNotes: (mount, options) => {
      const workspace = setupNotes(mount, options);
      return { ...workspace, pending: () => noteEntries(workspace) };
    },
    addMarkdownTemplatePicker, createSourceIdea, show, names,
    getPreferences: () => preferences,
    getMain: () => $('wb-main'), lifeApi: window.stilltimeDesktop.life,
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / 1024 ** exponent).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][exponent];
}
const canReadFile = file => file.isPdf || file.isMarkdown || file.isDocx;
const readerLocation = file => file.isPdf ? '阅读 PDF' : file.isDocx ? '阅读 Word' : '阅读 Markdown';

function setupFiles(panel) {
  panel.innerHTML = `
    <div data-file-overview>${heading('上传文件', '将本地文件收入工作区。在工作台阅读 PDF、Markdown 和 Word 文档。')}
      <div class="wb-drop" data-file-drop><span class="wb-card-icon" data-wb-icon="file"></span><div><strong>拖入本地文件</strong><p>任意文件类型，可批量导入。</p></div><button type="button" class="wb-button wb-primary" data-file-pick>选择文件</button></div>
      <div class="wb-panel wb-file-panel">
        <div class="wb-section-heading"><h2>文件</h2><span class="wb-result" data-file-count></span></div>
        <input class="wb-search" type="search" data-file-search aria-label="搜索文件" placeholder="搜索文件名称">
        <div data-file-list class="wb-list"></div>
      </div>
    </div>
    <div class="wb-file-workspace">
      <aside class="wb-file-tab-rail" aria-label="打开的文件" data-file-tab-rail hidden>
        <div data-file-tabs></div>
        <button type="button" class="wb-button wb-file-add" data-file-back aria-label="打开文件列表"><span data-wb-icon="plus"></span><span>文件列表</span></button>
      </aside>
      <div class="wb-file-readers" data-file-reader hidden></div>
    </div>`;
  const overview = assign(panel, '[data-file-overview]');
  const shell = assign(panel, '.wb-file-workspace');
  const reader = assign(panel, '[data-file-reader]');
  const rail = assign(panel, '[data-file-tab-rail]');
  const fileTabs = assign(panel, '[data-file-tabs]');
  const drop = assign(panel, '[data-file-drop]');
  const pick = assign(panel, '[data-file-pick]');
  const count = assign(panel, '[data-file-count]');
  const results = assign(panel, '[data-file-list]');
  const search = assign(panel, '[data-file-search]');
  const readers = new Map();
  let files = [], importing = false, opened = null, request = 0, navigation = 0, sourceRequest = 0;
  shell.append(overview);

  function renderTabs() {
    rail.hidden = readers.size === 0;
    shell.classList.toggle('has-pdf-tabs', readers.size > 0);
    fileTabs.replaceChildren(...[...readers.values()].map(entry => {
      const row = node('div', 'wb-file-tab');
      const button = action(entry.file.name, () => activate(entry), 'wb-file-tab-label');
      button.title = entry.file.name;
      if (entry === opened) button.setAttribute('aria-current', 'true');
      const close = action('×', () => closeReader(entry), 'wb-file-tab-close');
      close.setAttribute('aria-label', `关闭 ${entry.file.name}`);
      row.append(button, close);
      return row;
    }));
  }

  function activate(entry) {
    sourceRequest++;
    navigation++;
    opened = entry;
    show('files', { load: false });
    overview.hidden = Boolean(entry);
    reader.hidden = !entry;
    for (const tab of readers.values()) tab.mount.hidden = tab !== entry;
    $('wb-location').textContent = entry ? readerLocation(entry.file) : '上传文件';
    $('wb-main').scrollTop = 0;
    renderTabs();
    entry?.notes?.onViewEnter?.();
  }

  function closeReader(entry) {
    if (entry.notes && !entry.notes.canSwitch()) return;
    if (entry.notes?.isDirty() && !confirm('关闭此文件会丢弃它尚未保存的笔记。继续吗？')) return;
    entry.notes?.dispose({ discard: true });
    entry.inline?.dispose();
    entry.documentZoom?.dispose();
    entry.pdf?.dispose();
    entry.mount.remove();
    readers.delete(entry.file.id);
    if (entry === opened) activate([...readers.values()].at(-1) ?? null);
    else renderTabs();
  }

  async function mountReader(entry) {
    const { file, mount } = entry;
    const title = assign(mount, '[data-file-title]');
    const viewer = assign(mount, '[data-pdf-view]');
    title.textContent = file.name;
    empty(viewer, '正在打开文件…');
    try {
      entry.inline = createInlineTranslation(assign(mount, '[data-pdf-translation]'), window.stilltimeDesktop.translation);
      void entry.inline.load();
      if (!file.isPdf) {
        viewer.replaceChildren();
        viewer.classList.add('document-reader');
        const toolbar = node('div', 'workbench-pdf__toolbar document-reader__toolbar');
        const content = node('div', 'document-reader__viewport');
        let selected = '';
        const translate = action('翻译选中文字', () => {
          const text = selectedDocumentText(content) || selected;
          if (!text) { notice('请先选中文档中的文字。'); return; }
          void entry.inline.openSelection({ text, source: { type: 'document', title: file.name, fileId: file.id } });
        }, 'wb-button', 'language');
        translate.dataset.readerTranslate = '';
        translate.addEventListener('pointerdown', () => { selected = selectedDocumentText(content); });
        content.addEventListener('click', event => {
          handleMarkdownLink(event, { openLink: url => api.openLink(url), onError: error => notice(errorText(error), true) });
        });
        toolbar.append(translate);
        viewer.append(toolbar, content);
        entry.documentZoom = setupDocumentReaderZoom(content, toolbar);
        entry.notes = setupNotes(assign(mount, '[data-pdf-notes]'), {
          file,
          onOpenFile: () => { activate(entry); },
          onTranslate: selection => entry.inline.openSelection(selection),
        });
        void entry.notes.load();
        await renderDocumentPreview(content, file.id);
        return readers.get(file.id) === entry;
      }
      const { createWorkbenchPdf } = await import('./workbench-pdf.mjs');
      if (readers.get(file.id) !== entry) return false;
      entry.pdf = createWorkbenchPdf(viewer, {
        onPageChange: (page, total) => entry.notes?.onPageChange(page, total),
        onCreateIdea: selection => createSourceIdea({ ...selection, type: 'pdf', fileId: file.id, fileName: file.name }),
        onTranslateSelection: selection => entry.inline.openSelection({ ...selection, source: {
          type: 'pdf', title: file.name, fileId: file.id, page: selection.page,
        } }),
      });
      entry.notes = setupNotes(assign(mount, '[data-pdf-notes]'), {
        file,
        currentPage: () => entry.pdf.page,
        pageCount: () => entry.pdf.total,
        jumpToPage: page => entry.pdf.goToPage(page),
        onOpenFile: (_fileId, page) => entry.pdf.goToPage(page),
        onTranslate: selection => entry.inline.openSelection(selection),
      });
      void entry.notes.load();
      return await entry.pdf.open(new URL('/api/workbench/pdf/' + encodeURIComponent(file.id), location.href).href);
    } catch (error) {
      if (readers.get(file.id) === entry) empty(viewer, errorText(error));
      return false;
    }
  }

  async function openReader(file, source) {
    let entry = readers.get(file.id);
    if (entry?.failed) {
      closeReader(entry);
      if (readers.has(file.id)) return false;
      entry = null;
    }
    if (!entry) {
      const mount = node('section', 'wb-pdf-reader-tab');
      mount.innerHTML = `<header class="wb-reader-heading"><h1 data-file-title></h1></header>
        <div class="wb-reader">
          <section class="wb-pdf-panel" data-pdf-view></section>
          <div class="wb-pdf-sidebar">
            <section class="wb-panel wb-pdf-translation" data-pdf-translation aria-label="选区翻译"></section>
            <section class="wb-reader-notes" data-pdf-notes aria-label="阅读笔记"></section>
          </div>
        </div>`;
      reader.append(mount);
      entry = { file, mount };
      readers.set(file.id, entry);
      activate(entry);
      entry.ready = mountReader(entry).then(ready => { entry.failed = !ready; return ready; });
    } else activate(entry);
    const token = navigation;
    if (!await entry.ready || token !== navigation) return false;
    if (!source) return true;
    if (entry.pdf && source.page && !source.quote) await entry.pdf.goToPage(source.page);
    if (token !== navigation) return false;
    if (source.noteId) return entry.notes.openResult(source.noteId, 'note', source.anchor);
    if (source.quote && entry.pdf && !await entry.pdf.goToQuote(source.page, source.quote)) notice('未找到对应的原文。卡片仍保留摘录。', true);
    return true;
  }

  async function openSource(source) {
    const originView = current;
    const token = ++sourceRequest;
    const file = (await api.listFiles()).find(item => item.id === source.fileId && canReadFile(item));
    if (token !== sourceRequest || current !== originView) return false;
    if (!file) { notice('文件库中找不到原文档。', true); return false; }
    return openReader(file, source);
  }
  function render() {
    const query = search.value.normalize('NFKC').toLowerCase().trim();
    const shown = files.filter(file => file.name.normalize('NFKC').toLowerCase().includes(query));
    count.textContent = countLabel(shown.length);
    if (!shown.length) { empty(results, query ? '没有找到匹配的文件。' : '导入后，文件会出现在这里。'); return; }
    results.replaceChildren(...shown.map(file => {
      const entry = node('article', 'wb-entry wb-file-entry');
      const type = file.isPdf ? 'PDF' : (file.name.includes('.') ? file.name.split('.').pop().slice(0, 7).toUpperCase() : '文件');
      const label = node('span', 'wb-file-type', type);
      const meta = node('div', 'wb-file-info');
      const title = canReadFile(file) ? action(file.name, () => void openReader(file), 'wb-entry-title') : node('strong', 'wb-entry-title', file.name);
      title.title = file.name;
      meta.append(title, node('p', 'wb-date', formatSize(file.size) + '  ·  ' + dateLabel(file.importedAt)));
      const buttons = node('div', 'wb-entry-actions');
      if (canReadFile(file)) buttons.append(action('阅读', () => void openReader(file), 'wb-button wb-quiet-accent', 'arrowUpRight'));
      buttons.append(action('在文件夹中显示', () => api.revealFile(file.id).catch(error => notice(errorText(error), true))));
      entry.append(label, meta, buttons);
      return entry;
    }));
  }
  async function load() {
    const token = ++request;
    try {
      const items = await api.listFiles();
      if (token === request) { files = items; render(); }
    } catch (error) { if (token === request) empty(results, errorText(error)); }
  }
  async function importFiles(importer) {
    if (importing) return;
    importing = true;
    pick.disabled = true;
    pick.textContent = '导入中…';
    try {
      const result = await importer();
      if (!result) return;
      if (result.items?.length) { search.value = ''; await load(); }
      const errors = result.errors ?? [];
      const details = errors.map(error => typeof error === 'string' ? error : [error.name || error.path, error.message || error.error].filter(Boolean).join('：')).filter(Boolean);
      if (errors.length) notice('已导入 ' + (result.items?.length ?? 0) + ' 个文件。' + details.slice(0, 3).join('；'), true);
      else if (result.items?.length) notice('已导入 ' + result.items.length + ' 个文件');
    } catch (error) { notice(errorText(error), true); }
    finally {
      importing = false;
      pick.disabled = false;
      pick.textContent = '选择文件';
    }
  }
  search.oninput = render;
  pick.onclick = () => importFiles(() => api.importFiles());
  assign(panel, '[data-file-back]').onclick = () => { activate(null); void load(); pick.focus(); };
  drop.ondragover = event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    drop.classList.add('wb-dragging');
  };
  drop.ondragleave = event => { if (!drop.contains(event.relatedTarget)) drop.classList.remove('wb-dragging'); };
  drop.ondrop = event => {
    event.preventDefault();
    drop.classList.remove('wb-dragging');
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void importFiles(() => api.dropFiles(files));
  };
  return {
    load, openSource,
    onExternalNotesChange() {
      for (const entry of readers.values()) entry.notes?.onExternalChange?.();
    },
    location: () => opened ? readerLocation(opened.file) : names.files,
    pendingEntries: () => [...readers.values()].flatMap(entry => entry.notes ? noteEntries(entry.notes).map(item => ({
      ...item,
      key: entry.file.id + '/' + item.key,
      location: '阅读笔记 · ' + entry.file.name,
      focus: () => { activate(entry); return item.focus(); },
    })) : []),
    requestSave: () => opened?.notes?.requestSave(),
    isDirty: () => [...readers.values()].some(entry => entry.notes?.isDirty()),
  };
}

async function openIdeaSource(source) {
  try {
    if (source.type === 'pdf') await tabs.files.openSource(source);
    else if (source.type === 'link' && source.linkId) await tabs.links.openSource(source.linkId);
    else await api.openLink(source.url ?? source);
  } catch (error) { notice(errorText(error), true); }
}
const openTools = type => document.querySelector('[data-risk-open="' + type + '"]')?.click();
const translationPopup = $('wb-translation-popup');
const translationContent = $('wb-translation-content');
function closeTranslationPopup() {
  $('wb-translation').append(translationContent);
  if (translationPopup.open) translationPopup.close();
}
translationPopup.querySelector('[data-translation-close]').onclick = closeTranslationPopup;
translationPopup.querySelector('[data-translation-full]').onclick = () => { closeTranslationPopup(); show('translation'); };
translationPopup.addEventListener('close', () => {
  if (translationContent.parentElement === translationPopup) closeTranslationPopup();
});
async function openIdea(id) {
  show('ideas');
  return tabs.ideas.openResult({ id, type: 'idea' });
}
const tabs = {
  links: setupLinks($('wb-links')), notes: setupNotes($('wb-notes')), files: setupFiles($('wb-files')),
  clipboard: setupClipboardPage($('wb-clipboard'), { api: clipboard, notice }),
  settings: createWorkbenchSettings($('wb-settings'), {
    api: window.stilltimeDesktop, showNotice: notice, onPreview: previewStartup, onTestVoice: testStartupVoice,
  }),
  ideas: setupIdeas($('wb-ideas'), { api: capture, getWorkDate, notice, errorText, openSource: openIdeaSource,
    openTools, getPreferences: () => preferences, selectAnchor, createTopic: idea => {
      show('life', { load: false });
      return tabs.life.createTopic(idea);
    } }),
  weekly: setupWeeklyReview($('wb-weekly'), {
    api: window.stilltimeDesktop.weeklyReview, notice, errorText, openIdea, openTools, selectAnchor,
  }),
  translation: createTranslationPanel(translationContent, window.stilltimeDesktop.translation, { openSource: openTranslationSource, clipboard }),
  life: setupLifeWorkbench($('wb-life'), { api: window.stilltimeDesktop.life, notice, errorText, openTools: () => openTools('mirror') }),
  ...setupResearch({ experimentsPanel: $('wb-experiments'), plansPanel: $('wb-plans'), api, notice, show, selectAnchor }),
};
const plansPanel = $('wb-plans');
const memoPanel = plansPanel.querySelector('[data-research-memos]');
const planGrid = plansPanel.querySelector('.wb-r-plan-grid');
const planHeading = plansPanel.querySelector('.wb-heading');
const planTabs = node('nav', 'wb-plan-tabs');
planTabs.setAttribute('aria-label', '备忘录与计划');
const memoTab = action('备忘录', () => showPlanMode(true));
const planTab = action('计划与目标', () => showPlanMode(false));
planTabs.append(memoTab, planTab);
plansPanel.prepend(planTabs);
memoPanel.classList.add('wb-memos');
const memos = setupNotes(memoPanel, { fixedKind: 'memo' });
const plans = tabs.plans;
function showPlanMode(memo, { load = true } = {}) {
  memoPanel.hidden = !memo;
  planGrid.hidden = memo;
  planHeading.hidden = memo;
  memoTab.setAttribute('aria-pressed', String(memo));
  planTab.setAttribute('aria-pressed', String(!memo));
  if (load) void (memo ? memos.load() : plans.load());
}
showPlanMode(true, { load: false });
tabs.plans = {
  ...plans,
  load: () => memoPanel.hidden ? plans.load() : memos.load(),
  requestSave: () => !memoPanel.hidden && memos.requestSave(),
  isDirty: () => plans.isDirty() || memos.isDirty(),
};
async function openSearchResult(result) {
  const { id, type, anchor, metadata = {} } = result;
  const [, parentId, ...fileParts] = String(result.relativePath ?? '').split(/[\\/]/);
  if (type === 'link') return tabs.links.openSource(id, { anchor });
  if (type === 'link-note') return tabs.links.openSourceNote(metadata.linkId || parentId, fileParts.join('/'), anchor);
  if (type === 'link-snapshot') return tabs.links.openSource(metadata.linkId || parentId);
  if (['note', 'daily', 'weekly', 'memo', 'pdf-note'].includes(type)) {
    const fileId = result.fileId || metadata.fileId;
    if (fileId) return tabs.files.openSource({ fileId, noteId: id, anchor, page: result.page || metadata.page });
    if (type === 'memo') { showPlanMode(true, { load: false }); show('plans', { load: false }); return memos.openResult(id, type, anchor); }
    show('notes');
    return tabs.notes.openResult(id, type, anchor);
  }
  if (type === 'experiment') { show('experiments'); return tabs.experiments.openResult(result); }
  if (type === 'idea' || type === 'inspiration-board') { show('ideas'); return tabs.ideas.openResult(result); }
  if (type === 'weekly-review') { show('weekly', { load: false }); return tabs.weekly.openResult(result); }
  if (['experience', 'mood', 'thinking', 'content', 'template', 'custom'].includes(type)) {
    const record = await window.stilltimeDesktop.life.get({ id, kind: type });
    if (!record) return false;
    show('life', { load: false });
    return tabs.life.openRecord(record);
  }
  return false;
}
function openTranslation(selection) {
  translationPopup.append(translationContent);
  if (!translationPopup.open) translationPopup.showModal();
  void tabs.translation.load();
  return tabs.translation.openSelection(selection);
}
function openTranslationSource(source) {
  closeTranslationPopup();
  if (source.fileId) return tabs.files.openSource(source);
  if (source.noteId) return openSearchResult({ id: source.noteId, type: source.kind || 'note' });
  return false;
}
mountGlobalSearch({ root: document.body, search: window.stilltimeDesktop.search, activate: openSearchResult });
renderWorkbenchIcons($('workbench'));
$('wb-today').textContent = new Date(getWorkDate() + 'T12:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
$('wb-today').dateTime = getWorkDate();
let current, previous = 'home', space;
let renderActive = await risk.getRenderActivity();
let homeRefreshTimer;
let resurfacing;
const homeDashboard = mountHomeDashboard({
  root: $('wb-home'), workbench: api, clipboard, prompts: window.stilltimeDesktop.prompts,
  getWorkDate, isActive: () => current === 'home' && renderActive, notice, errorText,
});
mountHomeTranslation({ container: $('wb-home-translation'), api: window.stilltimeDesktop.translation, clipboard, errorText });
function disposeSpace() {
  space?.dispose();
  space = null;
}
function refreshHomeSummary() {
  const date = getWorkDate();
  if ($('wb-today').dateTime !== date) updateWorkday(date);
  void refreshResurfacing(date);
  void homeDashboard.refreshPlan();
}
async function refreshResurfacing(date) {
  try {
    const result = await capture.today();
    if (date !== getWorkDate()) return;
    resurfacing = result.item;
    const title = resurfacing?.original || resurfacing?.title || '冰箱里暂时没有想法';
    $('wb-resurfacing-title').textContent = title;
    $('wb-resurfacing-open').title = resurfacing ? title : '';
    $('wb-resurfacing-open').disabled = !resurfacing;
  } catch {
    resurfacing = null;
    $('wb-resurfacing-title').textContent = '暂不可用';
    $('wb-resurfacing-open').title = '';
    $('wb-resurfacing-open').disabled = true;
  }
}
$('wb-resurfacing-open').onclick = () => {
  if (resurfacing) void openIdea(resurfacing.id).catch(error => notice(errorText(error), true));
};
function updateHomeTimer(event) {
  $('wb-timer-status').textContent = event?.detail?.text || $('timer').textContent.replace(/\s/g, '');
}
window.addEventListener('stilltime-timer-state', updateHomeTimer);
updateHomeTimer();
function syncSpace() {
  if (!isStartupActive() && current === 'home' && renderActive && preferences.showOuroboros !== false) {
    try { space ??= mountOuroborosFrame($('wb-space')); }
    catch (error) { console.warn('ReverseWear Ouroboros:', error); }
  } else disposeSpace();
}
window.addEventListener('stilltime-startup-active', syncSpace);
let activityGeneration = 0;
async function refreshRenderActivity() {
  const request = ++activityGeneration;
  try {
    const active = await risk.getRenderActivity();
    if (request !== activityGeneration || renderActive === active) return;
    renderActive = active;
    syncSpace();
    if (active && current === 'home') void refreshHomeSummary();
  } catch { /* Keep the latest activity delivered by the main process. */ }
}
function show(view, { load = true } = {}) {
  if (!Object.hasOwn(names, view) || current === view) return;
  const focus = view === 'focus';
  if (focus) previous = current && current !== 'focus' ? current : 'home';
  const notifyTimer = (current === 'focus') !== focus;
  current = view;
  document.body.classList.toggle('workbench-active', !focus);
  $('workbench').hidden = focus;
  for (const tab of ['home', ...Object.keys(tabs)]) $('wb-' + tab).hidden = tab !== view;
  document.querySelectorAll('.wb-nav [data-wb-nav], .wb-top [data-wb-nav]').forEach(button => {
    if (button.dataset.wbNav === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('wb-location').textContent = tabs[view]?.location?.() ?? names[view];
  $('wb-main').scrollTop = 0;
  syncSpace();
  const homeReady = view === 'home' && Promise.all([homeDashboard.open(), refreshResurfacing(getWorkDate())]);
  if (load && tabs[view]) {
    const options = view === 'notes' ? { reconcile: true } : undefined;
    void Promise.resolve(tabs[view].load(options)).catch(error => notice(errorText(error), true));
  }
  if (notifyTimer) window.dispatchEvent(new Event('stilltime-view-change'));
  return homeReady;
}
const renderActivityUnsubscribe = risk.onRenderActivity(active => {
  activityGeneration++;
  renderActive = active;
  syncSpace();
  if (active && current === 'home') void refreshHomeSummary();
});
const captureSavedUnsubscribe = capture.onCaptureSaved(() => {
  if (current === 'ideas') void tabs.ideas.load();
});
window.addEventListener('stilltime-risk-preferences', event => {
  const next = event.detail;
  if (!next || typeof next !== 'object') return;
  const previousWorkDate = getWorkDate();
  preferences.dayStartMinutes = next.dayStartMinutes;
  preferences.showOuroboros = next.showOuroboros;
  preferences.warnActionLimit = next.warnActionLimit;
  setDayStartMinutes(next.dayStartMinutes);
  const workDate = getWorkDate();
  updateWorkday(workDate, previousWorkDate);
  syncSpace();
  void refreshHomeSummary();
});
function updateWorkday(workDate, previousWorkDate = $('wb-today').dateTime) {
  plans.updateWorkDate(previousWorkDate, workDate);
  $('wb-today').dateTime = workDate;
  $('wb-today').textContent = new Date(workDate + 'T12:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
}
document.querySelectorAll('[data-wb-nav]').forEach(button => button.onclick = () => {
  const view = button.dataset.wbNav;
  if (view === 'plans') showPlanMode(!button.hasAttribute('data-today-plan'), { load: current === 'plans' });
  show(view);
});
window.addEventListener('keydown', event => {
  if (isStartupActive()) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
  if (!tabs[current]?.requestSave) return;
  event.preventDefault();
  if (!event.repeat && !document.querySelector('dialog[open]')) tabs[current].requestSave();
});
$('backToWorkbench').onclick = () => show(previous);
const articleNotice = node('aside', 'article-capture-notice');
articleNotice.setAttribute('aria-label', '网页收录提示');
articleNotice.hidden = true;
const articleNoticeLabel = node('span', 'article-capture-label');
const articleNoticeAccept = action('收录', () => {}, 'wb-button');
const articleNoticeClose = action('关闭', () => { articleNotice.hidden = true; }, 'wb-button');
articleNotice.append(articleNoticeLabel, articleNoticeAccept, articleNoticeClose);
$('workbench').append(articleNotice);
let articleNoticeTimer;
window.stilltimeDesktop.articles?.onClipboardLink(item => {
  const id = item?.id;
  if (!id || current === 'focus') return;
  articleNoticeLabel.textContent = '收录刚复制的网页？ ' + String(item.preview || '').slice(0, 160);
  articleNoticeAccept.disabled = false;
  articleNoticeAccept.hidden = false;
  articleNoticeAccept.textContent = '收录';
  articleNoticeAccept.onclick = async () => {
    clearTimeout(articleNoticeTimer);
    articleNoticeAccept.disabled = true;
    articleNoticeLabel.textContent = '正在收录网页…';
    try {
      const article = await window.stilltimeDesktop.articles.captureClipboard({ id });
      articleNoticeLabel.textContent = '已收藏 · ' + (article.title || article.url);
      articleNoticeAccept.textContent = '查看';
      articleNoticeAccept.disabled = false;
      articleNoticeAccept.onclick = () => {
        articleNotice.hidden = true;
        void tabs.links.openSource(article.id).catch(error => notice(errorText(error), true));
      };
    } catch (error) {
      articleNoticeLabel.textContent = errorText(error);
      articleNoticeAccept.disabled = false;
    }
  };
  articleNotice.hidden = false;
  clearTimeout(articleNoticeTimer);
  articleNoticeTimer = setTimeout(() => { articleNotice.hidden = true; }, 9000);
});
window.stilltimeDesktop.articles?.onClipboardResult(result => {
  if (result?.error) notice(result.error, true);
  else if (result?.title) notice('已收录 · ' + result.title);
});
window.stilltimeDesktop.articles?.onChanged(() => {
  if (current === 'links') void tabs.links.load().catch(error => notice(errorText(error), true));
});
window.stilltimeDesktop.onIndexChanged?.(categories => {
  if (!Array.isArray(categories)) return;
  if (categories.some(category => ['notes', 'daily', 'weekly'].includes(category))) tabs.notes.onExternalChange(categories);
  if (categories.includes('notes')) tabs.files.onExternalNotesChange();
  if (categories.includes('memos')) memos.onExternalChange(categories);
  if (categories.some(category => category === 'links' || category === 'linknotes')) tabs.links.onExternalChange?.(categories);
});
window.stilltimeDesktop.desktopSuite?.onWorkbenchAction(action => {
  if (action.command === 'note.new') {
    show('notes');
    tabs.notes.newDraft();
  } else if (action.command === 'translation.open') {
    show('translation');
  } else if (action.fileId && ['reader.open-pdf', 'reader.open-path'].includes(action.command)) {
    void tabs.files.openSource({ fileId: action.fileId }).catch(error => notice(errorText(error), true));
  }
});
window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('focus', () => {
  if (current === 'links' || current === 'ideas') void tabs[current].load();
});
window.addEventListener('focus', refreshRenderActivity);
document.addEventListener('visibilitychange', refreshRenderActivity);
setTimeout(refreshRenderActivity, 400);
homeRefreshTimer = setInterval(() => { if (current === 'home' && renderActive) void refreshHomeSummary(); }, 15000);
const homeTimer = mountHomeTimer({
  root: $('wb-home'),
  appendTimeline: input => window.stilltimeDesktop.life.appendTimeline(input),
  notice,
});
const windowApi = window.stilltimeDesktop.window;
setupWindowControls(windowApi);
setupQuitDialog({
  api: windowApi,
  root: $('wb-quit'),
  collect() {
    const moduleEntries = (view, entries, location = names[view], prepare) => entries.map(item => ({
      ...item,
      key: view + '/' + item.key,
      location: item.location || item.context || location,
      label: item.label || item.title,
      focus: async () => {
        prepare?.();
        show(view, { load: false });
        await (item.focus ?? item.activate)?.();
      },
    }));
    return [
      ...moduleEntries('home', homeTimer.pendingEntries().map(item => ({
        ...item,
        save: () => { show('home', { load: false }); return item.save(); },
        focusAfterSaveFailure: false,
      }))),
      ...moduleEntries('notes', noteEntries(tabs.notes)),
      ...moduleEntries('plans', noteEntries(memos), '备忘录', () => showPlanMode(true, { load: false })),
      ...moduleEntries('plans', plans.pendingEntries(), '计划与目标', () => showPlanMode(false, { load: false })),
      ...moduleEntries('files', tabs.files.pendingEntries()),
      ...moduleEntries('links', tabs.links.pending().map(item => ({ ...item, focus: item.activate }))),
      ...moduleEntries('settings', tabs.settings.pendingEntries()),
      ...['ideas', 'weekly', 'life', 'experiments'].flatMap(view => moduleEntries(view, tabs[view].pendingEntries?.() ?? [])),
    ];
  },
  notice,
});
const tagFields = 'input[name="tags"], input[data-bulk-tag-value], input[data-idea-tag], input[data-filter="tag"], input[aria-label^="重命名标签 "], input[aria-label$="的别名，用逗号分隔"]';
const mountedTags = new WeakSet();
function attachTagFields(root) {
  const inputs = root.matches?.(tagFields) ? [root] : root.querySelectorAll?.(tagFields) ?? [];
  for (const input of inputs) {
    if (mountedTags.has(input)) continue;
    mountedTags.add(input);
    mountTagSuggestions(input, { listRecent: window.stilltimeDesktop.recentTags.list });
  }
}
attachTagFields(document);
new MutationObserver(records => {
  for (const record of records) for (const element of record.addedNodes) {
    if (element.isConnected) attachTagFields(element);
  }
}).observe(document.body, { subtree: true, childList: true });

window.addEventListener('beforeunload', event => {
  if (homeTimer.isDirty() || Object.values(tabs).some(tab => tab.isDirty?.())) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  clearInterval(homeRefreshTimer);
  renderActivityUnsubscribe();
  homeDashboard.dispose();
  captureSavedUnsubscribe();
  homeTimer.dispose();
  disposeSpace();
}, { once: true });
const clock = document.querySelector('.wb-focus-clock');
const timer = $('timer');
function updateFocusClock() { clock.textContent = $('startText').textContent === '暂停片刻' ? timer.textContent : ''; }
new MutationObserver(updateFocusClock).observe(timer, { childList: true, subtree: true });
updateFocusClock();
Promise.resolve(show(new URLSearchParams(location.search).get('view') === 'focus' ? 'focus' : 'home'))
  .finally(markStartupWorkbenchReady);
