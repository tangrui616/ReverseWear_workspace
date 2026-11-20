import { setMarkdownContent, handleMarkdownLink } from './markdown-renderer.mjs';

const kinds = [
  ['experience', '生活经历'], ['mood', '情绪日记'], ['thinking', '思考页'], ['content', '内容看板'], ['template', '模板'], ['custom', '自定义领域'],
];
const stages = [['topic', '选题'], ['script', '脚本'], ['production', '制作'], ['published', '发布']];
const fieldsByKind = {
  experience: [['happenedAt', '时间', 'date'], ['area', '领域', 'text'], ['place', '地点', 'text'], ['event', '发生了什么', 'area'], ['learning', '学到什么', 'area']],
  mood: [['happenedAt', '日期', 'date'], ['trigger', '发生了什么', 'area'], ['feelings', '感受', 'area'], ['thoughts', '当时的想法', 'area'], ['needs', '我需要什么', 'area'], ['nextStep', '下一步', 'area']],
  thinking: [['question', '问题', 'area'], ['freeWrite', '自由写', 'area'], ['aiQuestions', 'AI 追问（可留空）', 'area'], ['answers', '我的回答', 'area'], ['conclusion', '结论 / 下一步', 'area']],
  content: [['topic', '选题', 'area'], ['script', '脚本', 'area'], ['publication', '发布记录', 'area']],
  template: [['templateBody', '模板正文（Markdown）', 'area']],
  custom: [['templateBody', '内容', 'area']],
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function errorMessage(error) { return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(error); }

export function setupLifeWorkbench(panel, { api, notice, openTools = () => {} }) {
  panel.addEventListener('click', event => handleMarkdownLink(event, {
    openLink: url => window.stilltimeDesktop.workbench.openLink(url),
    onError: error => notice(errorMessage(error), true),
  }));
  panel.classList.add('wb-life');
  panel.innerHTML = `
    <header class="wb-heading"><div><h1>生活与思考</h1><p>经历、情绪、想法与内容进度，保存在本地 Markdown。</p></div></header>
    <div class="wb-life-tabs" role="tablist" aria-label="生活与思考分类"></div>
    <div class="wb-life-layout">
      <section class="wb-panel wb-life-list-panel"><div class="wb-section-heading"><h2 data-life-list-title>记录</h2><button class="wb-button wb-primary" type="button" data-life-new>新建</button></div><div class="wb-life-records" data-life-records></div></section>
      <section class="wb-panel wb-life-editor"><div class="wb-section-heading"><h2 data-life-editor-title>新建记录</h2><span data-life-status class="wb-result" role="status"></span></div><form data-life-form><label class="wb-life-field"><span>标题</span><input data-life-title maxlength="240" required></label><label class="wb-life-field"><span>领域</span><input data-life-area maxlength="100" placeholder="例如：旅行、家庭、语言学习"></label><label class="wb-life-privacy-toggle" data-life-thinking-privacy hidden><input type="checkbox" data-life-private checked><span>保持私密，不进入 AI 镜像</span><button type="button" class="wb-button" data-life-review>打开 AI 审核</button></label><div data-life-fields></div><div data-life-template-actions class="wb-life-template-actions" hidden><button type="button" class="wb-button" data-life-use-template>将模板应用到当前类型</button><select data-life-template-select aria-label="选择模板"></select></div><div class="wb-form-footer"><span class="wb-life-privacy" data-life-privacy></span><button type="submit" class="wb-button wb-primary" data-life-save>保存到 Markdown</button></div></form></section>
    </div>
    <section class="wb-panel wb-life-board" data-life-board hidden><div class="wb-section-heading"><div><h2>内容创作看板</h2><p class="wb-muted">拖动卡片切换进度，也可打开卡片编辑。</p></div></div><div class="wb-life-columns" data-life-columns></div></section>`;
  const $ = selector => panel.querySelector(selector);
  const tabs = $('.wb-life-tabs');
  const list = $('[data-life-records]');
  const fieldsContainer = $('[data-life-fields]');
  const titleInput = $('[data-life-title]');
  const areaInput = $('[data-life-area]');
  const templateSelect = $('[data-life-template-select]');
  let activeKind = 'experience';
  let selected = null;
  let templates = [];
  let dirty = false;
  let saving = false;
  let loadGeneration = 0;

  function createTabs() {
    tabs.replaceChildren();
    for (const [kind, label] of kinds) {
      const button = el('button', label, 'wb-life-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(kind === activeKind));
      button.onclick = () => { if (dirty && !confirm('当前内容尚未保存，切换后会丢弃。继续吗？')) return; activeKind = kind; selected = null; dirty = false; renderForm(); load().catch(error => notice(errorMessage(error), true)); };
      tabs.append(button);
    }
  }

  function renderForm(record = null) {
    selected = record;
    titleInput.value = record?.title ?? '';
    areaInput.value = record?.area ?? '';
    fieldsContainer.replaceChildren();
    const isTimeline = activeKind === 'experience' && record?.area === '时间轴';
    for (const [key, label, type] of fieldsByKind[activeKind]) {
      const wrapper = el('label', undefined, 'wb-life-field');
      wrapper.append(el('span', isTimeline && key === 'event' ? '时间轴记录' : label));
      const field = type === 'area' ? document.createElement('textarea') : document.createElement('input');
      if (type !== 'area') field.type = type;
      field.dataset.lifeField = key;
      if (!isTimeline || key !== 'event') field.maxLength = key === 'freeWrite' || key === 'script' ? 30000 : 12000;
      field.value = record?.fields?.[key] ?? '';
      field.addEventListener('input', () => { dirty = true; });
      wrapper.append(field);
      fieldsContainer.append(wrapper);
    }
    if (activeKind === 'content') {
      const wrapper = el('label', undefined, 'wb-life-field');
      wrapper.append(el('span', '进度'));
      const select = document.createElement('select');
      select.dataset.lifeField = 'stage';
      for (const [value, label] of stages) select.append(new Option(label, value));
      select.value = record?.fields?.stage ?? 'topic';
      select.onchange = () => { dirty = true; };
      wrapper.append(select);
      fieldsContainer.prepend(wrapper);
    }
    $('[data-life-editor-title]').textContent = record ? `编辑${kinds.find(([kind]) => kind === activeKind)?.[1]}` : `新建${kinds.find(([kind]) => kind === activeKind)?.[1]}`;
    $('[data-life-privacy]').textContent = activeKind === 'mood' ? '默认私密，仅保存在本地，不进入 AI 镜像。' : '保存为独立 Markdown 文件。';
    $('[data-life-thinking-privacy]').hidden = activeKind !== 'thinking';
    $('[data-life-private]').checked = record ? record.private : true;
    $('[data-life-template-actions]').hidden = !['experience', 'mood', 'thinking', 'content', 'custom'].includes(activeKind);
    dirty = false;
  }

  async function loadTemplates() {
    templates = await api.list({ kind: 'template' });
    templateSelect.replaceChildren(new Option('选择已保存的模板', ''));
    for (const template of templates) templateSelect.append(new Option(`${template.title}${template.area ? ` · ${template.area}` : ''}`, template.id));
  }

  function fillTemplate() {
    const template = templates.find(item => item.id === templateSelect.value);
    if (!template) return;
    const source = template.fields?.templateBody ?? '';
    const lines = source.split(/\r?\n/);
    const sections = [];
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].match(/^##\s+(.+)$/)?.[1];
      if (!heading) continue;
      let end = index + 1;
      while (end < lines.length && !/^##\s/.test(lines[end])) end++;
      sections.push([heading, lines.slice(index + 1, end).join('\n').replace(/^\n/, '').replace(/\n$/, '')]);
      index = end - 1;
    }
    const fields = [...fieldsContainer.querySelectorAll('[data-life-field]')];
    if (activeKind === 'custom') {
      const markdownField = fields.find(field => field.dataset.lifeField === 'templateBody');
      if (markdownField) markdownField.value = source;
    }
    for (const field of fields) {
      if (activeKind === 'custom') continue;
      const label = field.closest('label')?.querySelector('span')?.textContent;
      const section = sections.find(([heading]) => heading.trim() === label);
      if (section) field.value = section[1];
    }
    if (template.area) areaInput.value = template.area;
    dirty = true;
    notice('已将模板章节填入当前编辑页。');
  }

  function buildCard(record) {
    const card = el('article', undefined, 'wb-life-record');
    const open = el('button', record.title, 'wb-entry-title');
    open.type = 'button';
    open.onclick = async () => {
      if (dirty && !confirm('当前内容尚未保存，打开其他记录会丢弃。继续吗？')) return;
      try { renderForm(await api.get({ id: record.id, kind: activeKind })); }
      catch (error) { notice(errorMessage(error), true); }
    };
    card.append(open);
    const meta = [record.happenedAt, record.area, record.private ? '私密' : ''].filter(Boolean).join(' · ');
    if (meta) card.append(el('p', meta, 'wb-muted'));
    if (activeKind === 'content') card.append(el('p', stages.find(([key]) => key === record.status)?.[1] ?? '选题', 'wb-life-stage'));
    const excerpt = record.fields?.event ?? record.fields?.question ?? record.fields?.trigger ?? record.fields?.topic ?? record.fields?.templateBody ?? '';
    if (excerpt) {
      const summary = el('div', undefined, 'wb-life-excerpt markdown-content');
      setMarkdownContent(summary, excerpt.slice(0, 180), { inline: true });
      card.append(summary);
    }
    return card;
  }

  async function load() {
    createTabs();
    $('[data-life-list-title]').textContent = kinds.find(([kind]) => kind === activeKind)?.[1] ?? '记录';
    const generation = ++loadGeneration;
    const [records] = await Promise.all([api.list({ kind: activeKind }), templates.length ? Promise.resolve() : loadTemplates()]);
    if (generation !== loadGeneration) return;
    list.replaceChildren();
    if (!records.length) list.append(el('p', '还没有记录。', 'wb-empty'));
    records.forEach(record => list.append(buildCard(record)));
    const board = $('[data-life-board]');
    board.hidden = activeKind !== 'content';
    if (activeKind === 'content') renderBoard(records);
    if (activeKind === 'template') await loadTemplates();
  }

  function renderBoard(records) {
    const columns = $('[data-life-columns]');
    columns.replaceChildren();
    for (const [stage, label] of stages) {
      const column = el('section', undefined, 'wb-life-column');
      column.dataset.stage = stage;
      column.append(el('h3', label));
      const cards = el('div', undefined, 'wb-life-column-cards');
      cards.setAttribute('aria-label', `${label}卡片，可用方向键排序或移动`);
      cards.ondragover = event => event.preventDefault();
      cards.ondrop = async event => {
        event.preventDefault();
        const id = event.dataTransfer.getData('text/plain');
        const record = records.find(item => item.id === id);
        if (!record) return;
        const fields = { ...record.fields, stage };
        try { await api.save({ id, kind: 'content', title: record.title, area: record.area, private: record.private, fields, expectedUpdatedAt: record.updatedAt }); await load(); }
        catch (error) { notice(errorMessage(error), true); }
      };
      for (const record of records.filter(item => item.status === stage)) {
        const card = el('button', record.title, 'wb-life-board-card');
        card.type = 'button';
        card.draggable = true;
        card.dataset.recordId = record.id;
        card.setAttribute('aria-label', `${record.title}${record.private ? '，私密' : ''}，${label}，按方向键切换进度`);
        if (record.private) card.append(el('small', '私密', 'wb-life-private-badge'));
        card.ondragstart = event => event.dataTransfer.setData('text/plain', record.id);
        card.onclick = () => { if (!dirty || confirm('当前内容尚未保存，打开其他记录会丢弃。继续吗？')) renderForm(record); };
        card.onkeydown = async event => {
          const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!delta) return;
          event.preventDefault();
          const next = Math.max(0, Math.min(stages.length - 1, stages.findIndex(([key]) => key === stage) + delta));
          if (next === stages.findIndex(([key]) => key === stage)) return;
          try { await api.save({ id: record.id, kind: 'content', title: record.title, area: record.area, private: record.private, fields: { ...record.fields, stage: stages[next][0] }, expectedUpdatedAt: record.updatedAt }); await load(); }
          catch (error) { notice(errorMessage(error), true); }
        };
        cards.append(card);
      }
      column.append(cards);
      columns.append(column);
    }
  }

  $('[data-life-new]').onclick = () => { if (dirty && !confirm('当前内容尚未保存，继续新建会丢弃。继续吗？')) return; selected = null; renderForm(); };
  $('[data-life-review]').onclick = () => openTools();
  $('[data-life-use-template]').onclick = fillTemplate;
  $('[data-life-private]').addEventListener('change', () => { dirty = true; });
  $('[data-life-form]').addEventListener('input', () => { dirty = true; });
  async function saveCurrent() {
    if (saving) return;
    const form = $('[data-life-form]');
    if (!form.reportValidity()) return false;
    saving = true;
    $('[data-life-save]').disabled = true;
    const fields = Object.fromEntries([...fieldsContainer.querySelectorAll('[data-life-field]')].map(field => [field.dataset.lifeField, field.value]));
    try {
      const saved = await api.save({ id: selected?.id, kind: activeKind, title: titleInput.value, area: areaInput.value, private: activeKind === 'mood' || $('[data-life-private]').checked, fields, expectedUpdatedAt: selected?.updatedAt ?? null });
      selected = saved;
      dirty = false;
      $('[data-life-status]').textContent = `已保存 · ${saved.relativePath}`;
      notice('已保存到本地 Markdown。');
      await load();
      renderForm(saved);
      return !dirty;
    } catch (error) { notice(errorMessage(error), true); }
    finally { saving = false; $('[data-life-save]').disabled = false; }
    return false;
  }
  $('[data-life-form]').addEventListener('submit', async event => {
    event.preventDefault();
    await saveCurrent();
  });
  load().catch(error => notice(errorMessage(error), true));
  return {
    load,
    isDirty() { return dirty; },
    pendingEntries() {
      if (!dirty) return [];
      return [{
        key: `life:${activeKind}:${selected?.id || 'new'}`,
        label: `生活与思考 · ${kinds.find(([kind]) => kind === activeKind)?.[1] || '记录'} · ${titleInput.value.trim() || '未命名记录'}`,
        focus() {
          $('[data-life-form]').scrollIntoView({ behavior: 'smooth', block: 'center' });
          titleInput.focus();
        },
        save: saveCurrent,
      }];
    },
    openRecord(record) {
      if (dirty && !confirm('当前内容尚未保存，打开搜索结果会丢弃。继续吗？')) return Promise.resolve(false);
      activeKind = record.kind; renderForm(record); return load();
    },
    createTopic({ title = '', body = '', area = '', private: isPrivate = false } = {}) {
      if (dirty && !confirm('当前内容尚未保存，创建选题会丢弃。继续吗？')) return false;
      activeKind = 'content';
      renderForm({ title, area, private: isPrivate, fields: { topic: body, stage: 'topic' } });
      return load();
    },
  };
}
