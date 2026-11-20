import { addMarkdownTemplatePicker } from './markdown-templates.mjs';
import { setMarkdownContent, handleMarkdownLink } from './markdown-renderer.mjs';

const choices = [
  ['growing', '继续想'], ['action', '行动'], ['fridge', '放入冰箱'], ['archived', '归档（可恢复）'],
];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatError(error) {
  return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(error);
}

export function setupWeeklyReview(panel, { api, notice, errorText, openIdea, openTools, selectAnchor }) {
  panel.innerHTML = `
    <header class="wb-heading wb-weekly-heading">
      <div><h1>周复盘</h1><p data-week-label>正在读取本周记录</p></div>
      <div class="wb-inline-actions">
        <button type="button" class="wb-button" data-week-previous>上一周</button>
        <button type="button" class="wb-button" data-week-current>本周</button>
        <button type="button" class="wb-button" data-week-next>下一周</button>
      </div>
    </header>
    <section class="wb-panel wb-week-draft">
      <div class="wb-section-heading"><h2>Harness 本周整理草稿</h2><span data-draft-status class="wb-result">仅本地读取</span></div>
      <p class="wb-muted">本机 Harness 从你已共享的镜像记录整理草稿。</p>
      <p class="wb-week-draft-path" data-draft-path></p>
      <div data-draft-content class="wb-week-draft-content markdown-content">还没有本周草稿。</div>
      <div class="wb-inline-actions">
        <button type="button" class="wb-button" data-draft-refresh>重新读取</button>
        <button type="button" class="wb-button" data-draft-create>创建空白草稿模板</button>
        <button type="button" class="wb-button" data-draft-reveal>打开草稿目录</button>
        <button type="button" class="wb-button wb-primary" data-draft-review>前往 AI 审核</button>
      </div>
    </section>
    <section class="wb-panel wb-week-decisions">
      <div class="wb-section-heading"><div><h2>逐条决定本周新灵感</h2><p class="wb-muted">归档只改变状态，记录仍保留，可在灵感筛选中恢复。</p></div><span data-week-idea-count class="wb-result"></span></div>
      <div data-week-ideas class="wb-week-idea-list"></div>
      <div class="wb-form-footer"><span data-week-decision-status class="wb-result" role="status"></span><button type="button" class="wb-button wb-primary" data-week-save-decisions>保存决定</button></div>
    </section>
    <section class="wb-panel wb-week-recap">
      <div class="wb-section-heading"><h2>本周三句话</h2><span data-week-save-status class="wb-result" role="status"></span></div>
      <form data-weekly-recap-form>
      <label>本周最大的收获<textarea data-recap-win rows="3" maxlength="10000"></textarea></label>
      <label>最卡的地方<textarea data-recap-stuck rows="3" maxlength="10000"></textarea></label>
      <fieldset><legend>下周只做哪三件事</legend><input data-recap-next maxlength="2000" aria-label="下周第一件事"><input data-recap-next maxlength="2000" aria-label="下周第二件事"><input data-recap-next maxlength="2000" aria-label="下周第三件事"></fieldset>
      <label>本周心情（可选）<textarea data-recap-mood rows="2" maxlength="2000"></textarea></label>
      <div class="wb-form-footer"><span data-week-recap-status class="wb-result" role="status"></span><button type="button" class="wb-button wb-primary" data-week-save-recap>保存周复盘</button></div>
      </form>
    </section>`;
  panel.classList.add('wb-weekly-review');

  const $ = selector => panel.querySelector(selector);
  panel.addEventListener('click', event => handleMarkdownLink(event, {
    openLink: url => window.stilltimeDesktop.workbench.openLink(url),
    onError: error => notice(errorText(error), true),
  }));
  const weekLabel = $('[data-week-label]');
  const draftContent = $('[data-draft-content]');
  const ideaList = $('[data-week-ideas]');
  const recapInputs = {
    biggestWin: $('[data-recap-win]'), stuckPoint: $('[data-recap-stuck]'),
    nextThree: [...panel.querySelectorAll('[data-recap-next]')], mood: $('[data-recap-mood]'),
  };
  for (const field of [recapInputs.biggestWin, recapInputs.stuckPoint, recapInputs.mood]) {
    addMarkdownTemplatePicker(field, window.stilltimeDesktop.life, error => notice(formatError(error), true));
  }
  let week = '';
  let updatedAt = null;
  let dirty = false;
  let decisionDirty = false;
  let busy = false;
  let savingRecap = false;
  let savingDecisions = false;
  let loadedIdeas = [];
  const selectedDecisions = new Map();
  let generation = 0;

  function setDirty() { dirty = true; }
  for (const field of [recapInputs.biggestWin, recapInputs.stuckPoint, recapInputs.mood, ...recapInputs.nextThree]) field.addEventListener('input', setDirty);

  function setWeekControls() {
    const disabled = busy || savingRecap || savingDecisions;
    for (const button of panel.querySelectorAll('[data-week-previous],[data-week-current],[data-week-next],[data-week-save-decisions],[data-week-save-recap]')) button.disabled = disabled;
  }

  function renderIdeas(items) {
    loadedIdeas = items;
    $('[data-week-idea-count]').textContent = `${items.length} 条`;
    ideaList.replaceChildren();
    for (const item of items) {
      const row = el('article', null, 'wb-week-idea');
      const title = el('button', item.title || item.original.slice(0, 100) || '未命名灵感', 'wb-entry-title');
      title.type = 'button';
      title.onclick = () => openIdea(item.id).catch(error => notice(errorText(error), true));
      const excerpt = el('div', item.original || item.followup, 'wb-week-excerpt markdown-content');
      setMarkdownContent(excerpt, item.original || item.followup, { inline: true });
      const select = document.createElement('select');
      select.setAttribute('aria-label', `决定灵感：${item.title || item.original.slice(0, 50)}`);
      const savedDecision = item.weeklyDecisions?.[week];
      select.append(new Option(savedDecision ? '已保存：' + choices.find(([value]) => value === savedDecision)?.[1] : '暂不决定', ''));
      for (const [value, label] of choices) select.append(new Option(label, value));
      select.value = selectedDecisions.get(item.id) ?? '';
      select.onchange = () => {
        if (select.value) selectedDecisions.set(item.id, select.value);
        else selectedDecisions.delete(item.id);
        decisionDirty = true;
      };
      row.append(title, excerpt, select);
      ideaList.append(row);
    }
    if (!items.length) ideaList.append(el('p', '本周还没有新灵感。', 'wb-empty'));
  }

  async function loadDraft(token) {
    const result = await api.readDraft({ week });
    if (token !== generation) return;
    if (result.busy) {
      $('[data-draft-status]').textContent = 'Harness 正在整理，稍后重新读取。';
      return;
    }
    setMarkdownContent(draftContent, result.exists ? result.content : '还没有本周草稿。');
    $('[data-draft-status]').textContent = result.exists ? `只读 · 更新于 ${new Date(result.updatedAt).toLocaleString()}` : '尚未创建';
  }

  async function load({ force = false } = {}) {
    if (busy || savingRecap || savingDecisions || ((dirty || decisionDirty) && !force)) return false;
    busy = true;
    const token = ++generation;
    setWeekControls();
    try {
      week = week || await api.currentWeek();
      const [review, ideas] = await Promise.all([
        api.getReview({ week }), api.listWeekIdeas({ week }),
      ]);
      if (token !== generation) return false;
      updatedAt = review.updatedAt;
      $('[data-week-recap-status]').textContent = review.updatedAt ? '已保存到本地 Markdown。' : '';
      weekLabel.textContent = `${review.week} · ${review.start} 至 ${review.end}`;
      $('[data-draft-path]').textContent = 'AI-Mirror/Weekly-Review/' + week + '.md';
      recapInputs.biggestWin.value = review.recap.biggestWin;
      recapInputs.stuckPoint.value = review.recap.stuckPoint;
      recapInputs.nextThree.forEach((field, index) => { field.value = review.recap.nextThree[index] ?? ''; });
      recapInputs.mood.value = review.recap.mood;
      dirty = false;
      selectedDecisions.clear();
      decisionDirty = false;
      renderIdeas(ideas.items);
      await loadDraft(token).catch(error => {
        if (token === generation) $('[data-draft-status]').textContent = errorText(error);
      });
      return true;
    } catch (error) {
      if (token === generation) notice(errorText(error), true);
      return false;
    } finally {
      if (token === generation) { busy = false; setWeekControls(); }
    }
  }

  async function changeWeek(offset) {
    if (dirty || decisionDirty) {
      notice('本页有未保存内容，请先保存或刷新后切换周次。', true);
      return;
    }
    const [year, number] = week.split('-W').map(Number);
    const monday = new Date(year, 0, 4 - ((new Date(year, 0, 4).getDay() + 6) % 7) + (number - 1) * 7 + offset * 7);
    week = await api.weekForDate(`${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`);
    await load({ force: true });
  }

  $('[data-week-previous]').onclick = () => changeWeek(-1).catch(error => notice(errorText(error), true));
  $('[data-week-next]').onclick = () => changeWeek(1).catch(error => notice(errorText(error), true));
  $('[data-week-current]').onclick = async () => {
    if (dirty || decisionDirty) { notice('本页有未保存内容，请先保存或刷新后切换周次。', true); return; }
    week = await api.currentWeek();
    await load({ force: true });
  };
  $('[data-draft-refresh]').onclick = () => loadDraft(generation).catch(error => notice(errorText(error), true));
  $('[data-draft-create]').onclick = async () => {
    try {
      await api.writeDraftTemplate({ week });
      await loadDraft(generation);
      notice('已创建空白模板。');
    } catch (error) { notice(errorText(error), true); }
  };
  $('[data-draft-reveal]').onclick = async () => {
    try { await api.revealDraft({ week }); } catch (error) { notice(errorText(error), true); }
  };
  $('[data-draft-review]').onclick = () => openTools('mirror');
  async function saveDecisions() {
    const selections = loadedIdeas.filter(item => selectedDecisions.has(item.id)).map(item => ({ id: item.id, decision: selectedDecisions.get(item.id), expectedUpdatedAt: item.updatedAt }));
    const status = $('[data-week-decision-status]');
    if (!selections.length) { status.textContent = '请先选择想法的去向。'; return false; }
    savingDecisions = true;
    setWeekControls();
    try {
      const result = await api.decideIdeas({ week, decisions: selections });
      for (const entry of result.items) selectedDecisions.delete(entry.id);
      decisionDirty = selectedDecisions.size > 0;
      status.textContent = [
        `已保存 ${result.items.length} 条决定。`, result.warning,
        ...result.conflicts.map(entry => (entry.title || '想法') + '：' + entry.error),
      ].filter(Boolean).join(' ');
      renderIdeas((await api.listWeekIdeas({ week })).items);
      return !decisionDirty;
    } catch (error) { status.textContent = formatError(error); }
    finally { savingDecisions = false; setWeekControls(); }
    return false;
  }
  $('[data-week-save-decisions]').onclick = () => { void saveDecisions(); };
  async function saveRecap() {
    savingRecap = true;
    setWeekControls();
    const fields = [recapInputs.biggestWin, recapInputs.stuckPoint, recapInputs.mood, ...recapInputs.nextThree];
    const before = fields.map(field => field.value);
    try {
      const result = await api.saveReview({ week, expectedUpdatedAt: updatedAt, recap: {
        biggestWin: recapInputs.biggestWin.value, stuckPoint: recapInputs.stuckPoint.value,
        nextThree: recapInputs.nextThree.map(field => field.value), mood: recapInputs.mood.value,
      } });
      updatedAt = result.updatedAt;
      dirty = fields.some((field, index) => field.value !== before[index]);
      $('[data-week-recap-status]').textContent = '已保存到本地 Markdown。';
      return !dirty;
    } catch (error) { $('[data-week-recap-status]').textContent = formatError(error); }
    finally { savingRecap = false; setWeekControls(); }
    return false;
  }
  $('[data-week-save-recap]').onclick = () => { void saveRecap(); };
  setWeekControls();
  $('[data-weekly-recap-form]').addEventListener('submit', event => event.preventDefault());
  return {
    load, isDirty: () => dirty || decisionDirty || savingRecap || savingDecisions,
    pendingEntries() {
      const entries = [];
      if (dirty) entries.push({
        key: `weekly-review:recap:${week || 'current'}`,
        label: `周复盘 · ${week || '本周三句话'}`,
        focus() { recapInputs.biggestWin.scrollIntoView({ behavior: 'smooth', block: 'center' }); recapInputs.biggestWin.focus(); },
        save: saveRecap,
      });
      if (decisionDirty) entries.push({
        key: `weekly-review:decisions:${week || 'current'}`,
        label: `周复盘 · ${week || '灵感决定'}`,
        focus() { $('[data-week-ideas]').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('[data-week-ideas] select')?.focus(); },
        save: saveDecisions,
      });
      return entries;
    },
    async openResult(result) {
      const match = result?.relativePath?.match(/^WeeklyReviews[\\/](\d{4}-W\d{2})\.md$/i);
      if (!match) return false;
      if (dirty || decisionDirty) return false;
      if (week !== match[1]) {
        week = match[1];
        if (!await load({ force: true })) return false;
      }
      if (![recapInputs.biggestWin, recapInputs.stuckPoint, ...recapInputs.nextThree, recapInputs.mood].some(field => selectAnchor?.(field, result.anchor))) recapInputs.biggestWin.focus();
      return true;
    },
  };
}
