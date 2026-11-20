import { createWorkbenchIcon } from './icons.mjs';
import { getWorkDate } from './date-boundary.mjs';
import { addMarkdownTemplatePicker } from './markdown-templates.mjs';

const sectionNames = { design: '实验设计', rounds: '实验轮次', issues: '异常/问题', conclusion: '结论与下一步' };
const $ = (root, selector) => root.querySelector(selector);
const el = (tag, className, value) => { const result = document.createElement(tag); if (className) result.className = className; if (value !== undefined) result.textContent = value; return result; };
const action = (value, className, handler, type = 'button', iconName = '') => { const result = el('button', className, value); result.type = type; if (iconName) { const icon = createWorkbenchIcon(iconName); if (icon) result.append(icon); } if (handler) result.addEventListener('click', handler); return result; };
const today = () => getWorkDate();
const calendarToday = () => { const date = new Date(); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); };
const progress = value => Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
const errorText = error => String(error?.message || error);
const displayDate = value => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || ''); return match ? match[1] + '年' + Number(match[2]) + '月' + Number(match[3]) + '日' : '未设置日期'; };

function createExperiments(panel, api, notice, addPlan, selectAnchor) {
  panel.classList.add('wb-r');
  panel.innerHTML = `
    <header class="wb-heading wb-r-heading"><div><span class="wb-r-eyebrow">LABORATORY / RESEARCH LOG</span><h1>实验记录</h1><p>把设计、轮次与发现收在同一份实验记录中。</p></div><div class="wb-r-summary" aria-label="实验概览"></div></header>
    <section class="wb-r-create">
      <div class="wb-r-section-title"><span class="wb-r-glyph" aria-hidden="true" data-wb-icon="flask"></span><div><h2>开始一个新实验</h2><p>先记下研究目标，过程可以逐步补全。</p></div></div>
      <form class="wb-r-create-form" data-research-create>
        <label class="wb-r-field wb-r-field-wide">实验名称<input name="name" required maxlength="160" placeholder="例如：不同滤波策略对基频估计的影响"></label>
        <label class="wb-r-field">实验日期<input name="date" type="date" required></label>
        <label class="wb-r-field">当前进度 <span class="wb-r-range-value">0%</span><input name="progress" type="range" min="0" max="100" value="0"></label>
        <label class="wb-r-field wb-r-field-wide">下一步方案<input name="next" maxlength="240" placeholder="完成后准备做什么？"></label>
        <div class="wb-r-create-footer"><p class="wb-r-feedback" data-research-create-status role="status"></p><button type="submit" class="wb-r-primary" data-research-create-submit>创建实验 <span data-wb-icon="arrowUpRight" aria-hidden="true"></span></button></div>
      </form>
    </section>
    <section class="wb-panel wb-r-archive" aria-labelledby="wb-r-archive-title">
      <header class="wb-r-list-heading"><div><span class="wb-r-eyebrow">YOUR RESEARCH</span><h2 id="wb-r-archive-title">实验档案</h2></div><div class="wb-r-count"></div></header>
      <div class="wb-r-cards" aria-live="polite"></div>
    </section>
    <section class="wb-r-editor" data-research-editor hidden></section>`;
  const form = $(panel, '.wb-r-create-form'), createStatus = $(form, '.wb-r-feedback'), range = form.elements.progress;
  const rangeLabel = $(form, '.wb-r-range-value'), cards = $(panel, '.wb-r-cards'), editor = $(panel, '.wb-r-editor');
  const count = $(panel, '.wb-r-count'), summary = $(panel, '.wb-r-summary');
  let records = [], selected = null, activeTab = 'design', dirty = false, saving = false, createDirty = false, token = 0;
  function stat(label, value, unit) { const item = el('div', 'wb-r-stat'); item.append(el('span', 'wb-r-stat-label', label), el('strong', '', value), el('small', '', unit)); return item; }
  function updateSummary() {
    const completed = records.filter(item => item.completed).length;
    const average = records.length ? Math.round(records.reduce((sum, item) => sum + progress(item.progress), 0) / records.length) : 0;
    summary.replaceChildren(stat('实验总数', String(records.length), '条记录'), stat('进行中', String(records.length - completed), '项'), stat('平均进度', average + '%', '整体'), stat('已完成', String(completed), '项'));
  }
  function renderCards() {
    count.textContent = records.length ? records.length + ' 项实验' : '';
    cards.replaceChildren();
    if (!records.length) { const empty = el('div', 'wb-r-empty'); empty.append(el('span', 'wb-r-empty-mark', '◌'), el('strong', '', '实验档案从这里开始'), el('p', '', '创建第一条记录，逐步整理方案、轮次和结论。')); cards.append(empty); return; }
    records.forEach(item => {
      const card = action('', 'wb-r-experiment-card', () => openEditor(item));
      card.dataset.researchCard = item.id || '';
      card.setAttribute('aria-label', '编辑实验 ' + item.name);
      const top = el('div', 'wb-r-card-top');
      top.append(el('span', 'wb-r-card-date', displayDate(item.date)), el('span', 'wb-r-state' + (item.completed ? ' is-complete' : ''), item.completed ? '已完成' : '进行中'));
      const ratio = progress(item.progress), bar = el('div', 'wb-r-progress'), fill = el('span');
      fill.style.width = ratio + '%'; bar.append(fill);
      const footer = el('div', 'wb-r-card-footer');
      footer.append(el('span', '', item.next ? '下一步 · ' + item.next : '尚未填写下一步'), el('strong', '', ratio + '%'));
      card.append(top, el('strong', 'wb-r-card-name', item.name || '未命名实验'), bar, footer);
      cards.append(card);
    });
  }
  function field(label, name, value, type = 'text') {
    const wrapper = el('label', 'wb-r-field'), caption = el('span', '', label), input = el('input');
    input.name = name; input.type = type; input.value = value ?? ''; input.maxLength = 240;
    const valueLabel = el('span', 'wb-r-range-value', '');
    if (type === 'range') { input.min = '0'; input.max = '100'; valueLabel.textContent = progress(value) + '%'; wrapper.append(caption, valueLabel, input); }
    else wrapper.append(caption, input);
    return { wrapper, input, valueLabel };
  }
  function currentValues() {
    const read = key => editor.querySelector('[name="' + key + '"]')?.value ?? selected[key] ?? '';
    return { id: selected.id, name: read('name').trim(), date: read('date') || calendarToday(), progress: progress(read('progress')), next: read('next').trim(), design: read('design'), rounds: read('rounds'), issues: read('issues'), conclusion: read('conclusion'), completed: selected.completed === true, revision: selected.revision, contentHash: selected.contentHash };
  }
  function disableSaveControls(disabled) { editor.querySelectorAll('[data-research-save], [data-research-add-todo], [data-research-complete]').forEach(item => { item.disabled = disabled; }); }
  function renderEditor() {
    if (!selected) { editor.replaceChildren(); editor.hidden = true; return; }
    editor.hidden = false; editor.replaceChildren(el('div', 'wb-r-editor-rule'));
    const heading = el('div', 'wb-r-editor-titlebar'), left = el('div');
    left.append(el('span', 'wb-r-eyebrow', 'RESEARCH NOTE / ' + String(selected.id || '').slice(0, 8).toUpperCase()), el('h2', '', selected.name));
    heading.append(left, action('收起编辑', 'wb-r-secondary', closeEditor, 'button', 'close')); editor.append(heading);
    const fields = el('div', 'wb-r-editor-fields'), name = field('实验名称', 'name', selected.name), date = field('实验日期', 'date', selected.date || calendarToday(), 'date');
    name.input.maxLength = 160;
    const progressField = field('实验进度', 'progress', progress(selected.progress), 'range'), next = field('下一步方案', 'next', selected.next || '');
    fields.append(name.wrapper, date.wrapper, progressField.wrapper, next.wrapper); editor.append(fields);
    progressField.input.addEventListener('input', () => {
      progressField.valueLabel.textContent = progress(progressField.input.value) + '%';
      selected.progress = progress(progressField.input.value);
      markDirty();
    });
    const tabs = el('div', 'wb-r-tabs'); tabs.setAttribute('role', 'tablist');
    Object.entries(sectionNames).forEach(([key, value]) => {
      const tab = action(value, 'wb-r-tab' + (activeTab === key ? ' is-active' : ''), () => { activeTab = key; renderEditor(); });
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(activeTab === key)); tab.dataset.researchTab = key; tabs.append(tab);
    });
    const body = el('label', 'wb-r-field wb-r-section-editor'); body.append(el('span', 'wb-r-textarea-label', sectionNames[activeTab]));
    const area = el('textarea'); area.name = activeTab; area.rows = activeTab === 'rounds' ? 11 : 8;
    area.placeholder = { design: '写下研究问题、变量、材料、步骤与评价指标。', rounds: '按轮次记录参数、样本量、观察与结果。每一轮可以另起一段。', issues: '记录异常现象、失败条件、可能原因与待排查项。', conclusion: '整理当前结论、证据边界与下一步计划。' }[activeTab];
    area.value = selected[activeTab] || ''; body.append(area);
    area.addEventListener('input', () => { selected[activeTab] = area.value; markDirty(); });
    fields.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
      selected[input.name] = input.name === 'progress' ? progress(input.value) : input.value;
      markDirty();
    }));
    editor.append(tabs, body);
    addMarkdownTemplatePicker(area, window.stilltimeDesktop.life, error => notice(errorText(error), true));
    const footer = el('div', 'wb-r-savebar'), status = el('span', 'wb-r-feedback', dirty ? '有未保存的修改' : '已保存');
    status.dataset.researchSaveStatus = '';
    const addTodo = action('加入今日待办', 'wb-r-secondary', addTodayTodo, 'button', 'plus'); addTodo.dataset.researchAddTodo = '';
    const finish = action(selected.completed ? '已标记完成' : '标记实验完成', 'wb-r-complete', markComplete, 'button', 'check');
    finish.dataset.researchComplete = ''; finish.disabled = selected.completed || saving;
    const save = action('保存实验', 'wb-r-primary', () => void saveSelected(), 'button', 'check'); save.dataset.researchSave = '';
    footer.append(status, addTodo, finish, save); editor.append(footer);
    disableSaveControls(saving); if (selected.completed) finish.disabled = true;
  }
  function markDirty() {
    dirty = true;
    const status = editor.querySelector('[data-research-save-status]');
    if (status) status.textContent = '有未保存的修改';
  }
  function guarded() { return !saving && (!dirty || confirm('实验信息还没有保存。放弃本次修改？')); }
  function openEditor(item) {
    if (selected?.id === item.id) { editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (!guarded()) return;
    selected = { ...item }; activeTab = 'design'; dirty = false; renderCards(); renderEditor();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() { if (!guarded()) return; selected = null; dirty = false; renderCards(); renderEditor(); }
  async function saveSelected(markComplete = false) {
    if (!selected || saving) return null;
    const value = currentValues();
    if (!value.name) { notice('请先填写实验名称。', true); return null; }
    if (markComplete) { value.completed = true; value.progress = 100; }
    saving = true;
    const status = editor.querySelector('[data-research-save-status]');
    if (status) status.textContent = '正在保存…';
    disableSaveControls(true);
    try {
      selected = await api.saveExperiment(value); dirty = false; await load(); renderEditor();
      notice(markComplete ? '实验已保存并标记完成。' : '实验记录已保存。');
      return selected;
    } catch (error) {
      if (status) status.textContent = '保存失败，修改仍保留';
      notice('保存失败，修改仍保留：' + errorText(error), true);
      return null;
    }
    finally { saving = false; renderEditor(); }
  }
  async function markComplete() { await saveSelected(true); }
  async function addTodayTodo() {
    const item = dirty ? await saveSelected() : selected;
    if (!item) return;
    const task = String(item.next || '').trim();
    if (!task) { notice('请先填写下一步方案，再加入今日待办。', true); return; }
    try { await addPlan(item); }
    catch (error) { notice('加入待办失败：' + errorText(error), true); }
  }
  async function load() {
    const currentToken = ++token;
    try {
      const values = await api.listExperiments(); if (currentToken !== token) return;
      records = Array.isArray(values) ? values.slice() : [];
      records.sort((a, b) => Boolean(a.completed) !== Boolean(b.completed) ? Number(Boolean(a.completed)) - Number(Boolean(b.completed)) : String(b.date || '').localeCompare(String(a.date || '')));
      updateSummary(); renderCards();
      if (selected) {
        const current = records.find(item => item.id === selected.id);
        if (current && !dirty) selected = { ...current }; else if (!current && !dirty) selected = null;
        renderEditor();
      }
    } catch (error) { records = []; updateSummary(); cards.replaceChildren(el('p', 'wb-r-empty', '无法读取实验记录：' + errorText(error))); }
  }
  async function openResult({ id, anchor }) {
    const item = (await api.listExperiments()).find(record => record.id === id);
    if (!item) throw new Error('找不到这条实验记录。');
    openEditor(item);
    if (selected?.id !== id) return false;
    const section = Object.keys(sectionNames).find(key =>
      anchor && (selected[key]?.includes(anchor) || anchor === '## ' + sectionNames[key]));
    if (section && section !== activeTab) {
      activeTab = section;
      renderEditor();
    }
    if (!selectAnchor?.(editor.querySelector('textarea'), anchor)) selectAnchor?.(editor.querySelector('[name="next"]'), anchor);
    return true;
  }
  range.addEventListener('input', () => { rangeLabel.textContent = progress(range.value) + '%'; });
  form.elements.date.value = calendarToday();
  form.addEventListener('input', () => { createDirty = true; });
  form.addEventListener('change', () => { createDirty = true; });
  async function saveNewExperiment() {
    if (saving) return false;
    const nameValue = form.elements.name.value.trim(); if (!nameValue) { form.elements.name.focus(); return false; }
    const submit = $(form, '[type=submit]'); submit.disabled = true; createStatus.textContent = '正在创建实验…';
    try {
      const item = await api.saveExperiment({ name: nameValue, date: form.elements.date.value || calendarToday(), progress: progress(range.value), next: form.elements.next.value.trim(), design: '', rounds: '', issues: '', conclusion: '', completed: false });
      form.reset(); form.elements.date.value = calendarToday(); rangeLabel.textContent = '0%'; createDirty = false; createStatus.textContent = '实验记录已创建。';
      await load();
      if (!dirty || !selected) openEditor(records.find(record => record.id === item.id) || item);
      notice('已创建实验「' + item.name + '」。');
      return true;
    } catch (error) { createStatus.textContent = '创建失败：' + errorText(error); createStatus.classList.add('wb-r-error'); notice('创建实验失败：' + errorText(error), true); }
    finally { submit.disabled = false; }
    return false;
  }
  form.addEventListener('submit', async event => { event.preventDefault(); await saveNewExperiment(); });
  return {
    load, openResult, isDirty: () => dirty || createDirty,
    pendingEntries() {
      const entries = [];
      if (createDirty) entries.push({
        key: 'research:new-experiment',
        label: `实验记录 · ${form.elements.name.value.trim() || '新实验'}`,
        focus() { form.scrollIntoView({ behavior: 'smooth', block: 'center' }); form.elements.name.focus(); },
        save: saveNewExperiment,
      });
      if (dirty && selected) entries.push({
        key: `research:experiment:${selected.id}`,
        label: `实验记录 · ${selected.name || '未命名实验'}`,
        focus() { editor.scrollIntoView({ behavior: 'smooth', block: 'center' }); editor.querySelector('[name="name"]')?.focus(); },
        async save() { return Boolean(await saveSelected()); },
      });
      return entries;
    },
  };
}

function appendTask(period, date, task, list, api, notice, onChange) {
  const row = el('label', 'wb-r-task' + (task.done ? ' is-done' : '')), check = el('input');
  check.type = 'checkbox'; check.checked = task.done === true; check.setAttribute('aria-label', (task.done ? '重新打开：' : '完成：') + task.text);
  const copy = el('span', 'wb-r-task-copy'); copy.append(el('span', 'wb-r-task-text', task.text));
  if (task.experimentId) copy.append(el('small', 'wb-r-task-origin', '来自实验记录'));
  check.addEventListener('change', async () => {
    check.disabled = true;
    try {
      const result = await api.mutatePlan({ period, date, action: 'toggle', id: task.id, done: check.checked });
      onChange(result, date);
      notice(check.checked ? '已完成待办。' : '已重新打开待办。');
    }
    catch (error) { check.checked = !check.checked; notice('更新待办失败：' + errorText(error), true); }
    finally { check.disabled = false; }
  });
  row.append(check, copy); list.append(row);
}

function createPlans(panel, api, notice) {
  panel.classList.add('wb-r');
  panel.innerHTML = `
    <header class="wb-heading wb-r-heading"><div><span class="wb-r-eyebrow">NOTES / PLAN / REVIEW</span><h1>备忘录与计划</h1><p>把眼前要做的事和一周方向放在同一个安静的地方。</p></div><span class="wb-r-private"><i aria-hidden="true"></i> 本地 Markdown</span></header>
    <div class="wb-r-plan-grid">
      <section class="wb-r-plan-panel wb-r-plan-daily">
        <div class="wb-r-plan-heading"><div><span class="wb-r-eyebrow">TODAY / CHECKLIST</span><h2>每日计划</h2></div>
          <label class="wb-r-date-control"><span class="wb-visually-hidden">选择日期</span><input type="date" data-plan-date="day" aria-label="选择每日计划日期"></label></div>
        <div class="wb-r-plan-meter"><span data-plan-meter="day"></span></div><p class="wb-r-plan-summary" data-plan-summary="day"></p>
        <form class="wb-r-task-form" data-research-task-form="day"><input name="text" maxlength="240" required placeholder="添加今天要推进的一件事…" aria-label="添加每日待办"><button class="wb-r-primary" type="submit">添加 <span data-wb-icon="plus" aria-hidden="true"></span></button></form>
        <div class="wb-r-task-list" data-research-task-list="day" aria-live="polite"></div><div class="wb-r-plan-foot">每天一点点，计划就会有回音。</div>
      </section>
      <section class="wb-r-plan-panel wb-r-plan-weekly">
        <div class="wb-r-plan-heading"><div><span class="wb-r-eyebrow">THIS WEEK / DIRECTION</span><h2>每周目标</h2></div>
          <div class="wb-r-week-tools"><button type="button" data-week-step="-1" aria-label="上一周"><span data-wb-icon="chevronLeft" aria-hidden="true"></span></button><label class="wb-r-date-control"><span class="wb-visually-hidden">选择所在周日期</span><input type="date" data-plan-date="week" aria-label="选择每周目标所在日期"></label><button type="button" data-week-step="1" aria-label="下一周"><span data-wb-icon="chevronRight" aria-hidden="true"></span></button></div></div>
        <div class="wb-r-plan-meter"><span data-plan-meter="week"></span></div><p class="wb-r-plan-summary" data-plan-summary="week"></p>
        <form class="wb-r-task-form" data-research-task-form="week"><input name="text" maxlength="240" required placeholder="为本周设定一个可完成的目标…" aria-label="添加每周目标"><button class="wb-r-primary" type="submit">添加 <span data-wb-icon="plus" aria-hidden="true"></span></button></form>
        <div class="wb-r-task-list" data-research-task-list="week" aria-live="polite"></div><div class="wb-r-plan-foot">从目标开始，回到你想去的方向。</div>
      </section>
    </div><div data-research-memos></div>`;
  const dates = { day: today(), week: today() }, items = { day: [], week: [] }, tokens = { day: 0, week: 0 };
  let busy = false;
  const taskInput = period => $(panel, '[data-research-task-form="' + period + '"]').elements.text;
  const dateInput = period => $(panel, '[data-plan-date="' + period + '"]');
  function render(period) {
    const list = $(panel, '[data-research-task-list="' + period + '"]'); list.replaceChildren();
    const rows = items[period] || [], complete = rows.filter(item => item.done).length;
    const ratio = rows.length ? Math.round(complete * 100 / rows.length) : 0;
    $(panel, '[data-plan-summary="' + period + '"]').textContent = rows.length ? complete + ' / ' + rows.length + ' 已完成' : period === 'day' ? '今天的清单还空着，为重要的事留一个位置。' : '本周还没有目标，先定下想抵达的方向。';
    $(panel, '[data-plan-meter="' + period + '"]').style.width = ratio + '%';
    if (!rows.length) list.append(el('div', 'wb-r-plan-empty', period === 'day' ? '今天的计划从第一件事开始。' : '每周目标从这里开始。'));
    rows.forEach(task => appendTask(period, dates[period], task, list, api, notice, (result, changedDate) => {
      if (dates[period] !== changedDate || !Array.isArray(result.tasks)) return;
      items[period] = result.tasks;
      render(period);
    }));
  }
  async function loadPeriod(period) {
    const request = ++tokens[period];
    try {
      const result = await api.getPlan({ period, date: dates[period] }); if (request !== tokens[period]) return;
      dates[period] = result.date || dates[period]; dateInput(period).value = dates[period]; items[period] = Array.isArray(result.tasks) ? result.tasks : []; render(period);
    } catch (error) {
      if (request === tokens[period]) $(panel, '[data-research-task-list="' + period + '"]').replaceChildren(el('p', 'wb-r-plan-error', '无法读取计划：' + errorText(error)));
    }
  }
  function stepWeek(change) {
    const date = new Date(dates.week + 'T12:00:00'); date.setDate(date.getDate() + change * 7);
    dates.week = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    dateInput('week').value = dates.week; void loadPeriod('week');
  }
  ['day', 'week'].forEach(period => {
    dateInput(period).value = dates[period];
    dateInput(period).addEventListener('change', () => { dates[period] = dateInput(period).value || today(); void loadPeriod(period); });
    $(panel, '[data-research-task-form="' + period + '"]').addEventListener('submit', async event => {
      event.preventDefault(); await saveTask(period);
    });
  });
  async function saveTask(period) {
      if (busy) return false;
      const form = $(panel, '[data-research-task-form="' + period + '"]'), input = form.elements.text, value = input.value.trim(); if (!value) return false;
      const submit = $(form, '[type=submit]'); busy = true; submit.disabled = true;
      try {
        const result = await api.mutatePlan({ period, date: dates[period], action: 'add', text: value });
        dates[period] = result.date || dates[period]; dateInput(period).value = dates[period]; items[period] = result.tasks || []; input.value = ''; render(period);
        notice(period === 'day' ? '已加入每日计划。' : '已加入每周目标。');
        return input.value.trim() === '';
      } catch (error) { notice('保存计划失败：' + errorText(error), true); }
      finally { busy = false; submit.disabled = false; }
      return false;
  }
  panel.querySelectorAll('[data-week-step]').forEach(item => item.addEventListener('click', () => stepWeek(Number(item.dataset.weekStep))));
  return {
    async load() { await Promise.all([loadPeriod('day'), loadPeriod('week')]); },
    updateWorkDate(previous, next) {
      if (dates.day !== previous || previous === next) return;
      dates.day = next;
      dateInput('day').value = next;
      void loadPeriod('day');
    },
    isDirty: () => ['day', 'week'].some(period => taskInput(period).value.trim()),
    pendingEntries() {
      return ['day', 'week'].filter(period => taskInput(period).value.trim()).map(period => ({
        key: `research:plan:${period}:${dates[period]}`,
        label: `${period === 'day' ? '每日计划' : '每周目标'} · ${taskInput(period).value.trim()}`,
        focus() { taskInput(period).focus(); },
        save: () => saveTask(period),
      }));
    },
    async addExperiment(experiment) {
      const value = String(experiment.next || '').trim(); if (!value) { notice('先在实验记录中填写下一步方案，再加入今日待办。', true); return; }
      try { const date = today(), result = await api.mutatePlan({ period: 'day', date, action: 'add', text: value, experimentId: experiment.id }); dates.day = result.date || date; items.day = result.tasks || []; render('day'); notice('已加入今日待办：' + value); }
      catch (error) { notice('加入待办失败：' + errorText(error), true); }
    },
  };
}

export function setupResearch({ experimentsPanel, plansPanel, api, notice, selectAnchor }) {
  const plans = createPlans(plansPanel, api, notice);
  const experiments = createExperiments(experimentsPanel, api, notice, item => plans.addExperiment(item), selectAnchor);
  return { experiments, plans };
}
