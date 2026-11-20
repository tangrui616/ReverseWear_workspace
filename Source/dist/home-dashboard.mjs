export function mountHomeDashboard({ root, workbench, clipboard, prompts, getWorkDate, isActive, notice, errorText }) {
  const $ = selector => root.querySelector(selector);
  const todoForm = $('#wb-home-todo-form');
  const todoList = $('#wb-home-todos');
  const promptList = $('#wb-home-prompts');
  const recentList = $('#wb-home-clipboard');
  const time = $('#wb-home-clock-time');
  const calendar = $('#wb-home-calendar');
  const lunar = $('#wb-home-lunar');
  const hour = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const solarDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const lunarDate = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
  const lunarDays = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五',
    '十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
  let calendarStamp;
  let recentRevision = 0;
  let planRevision = 0;
  let planSignature;
  let planBusy = false;

  function updateClock() {
    const now = new Date();
    time.textContent = time.dateTime = hour.format(now);
    const date = solarDate.format(now);
    if (date === calendarStamp) return;
    calendarStamp = date;
    calendar.textContent = date;
    calendar.dateTime = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const parts = Object.fromEntries(lunarDate.formatToParts(now).map(({ type, value }) => [type, value]));
    lunar.textContent = `农历${parts.month || ''}${lunarDays[Number(parts.day) - 1] || parts.day || ''}`;
  }

  function item(tag, classes, text) {
    const element = document.createElement(tag);
    element.className = classes;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(label, fn, classes = 'wb-button') {
    const control = item('button', classes, label);
    control.type = 'button';
    control.onclick = fn;
    return control;
  }

  function empty(container, text) { container.replaceChildren(item('p', 'wb-empty', text)); }

  const dialog = document.createElement('dialog');
  dialog.className = 'wb-stopwatch-dialog';
  dialog.setAttribute('aria-labelledby', 'wb-prompt-title');
  dialog.innerHTML = `<form class="wb-form">
    <h2 id="wb-prompt-title">新建提示词</h2>
    <label>标题<input name="title" maxlength="240" required autofocus></label>
    <label>正文<textarea name="body" maxlength="120000" rows="9" required placeholder="可使用 Markdown"></textarea></label>
    <p role="status"></p><div><button type="button">取消</button><button type="submit">保存</button></div>
  </form>`;
  root.append(dialog);
  const editForm = dialog.querySelector('form');
  const savePrompt = editForm.querySelector('[type=submit]');
  const cancel = editForm.querySelector('[type=button]');
  let editing;
  function editPrompt(record) {
    editing = record;
    $('#wb-prompt-title').textContent = record ? '编辑提示词' : '新建提示词';
    editForm.elements.title.value = record?.title || '';
    editForm.elements.body.value = record?.body || '';
    editForm.querySelector('[role=status]').textContent = '';
    dialog.showModal();
  }
  $('#wb-home-prompt-new').onclick = () => editPrompt();
  cancel.onclick = () => dialog.close();
  dialog.oncancel = event => { if (savePrompt.disabled) event.preventDefault(); };
  editForm.onsubmit = async event => {
    event.preventDefault();
    savePrompt.disabled = cancel.disabled = true;
    try {
      await prompts.save({ id: editing?.id, title: editForm.elements.title.value, body: editForm.elements.body.value });
      dialog.close();
      notice('提示词已保存。');
      await refreshPrompts();
    } catch (error) { editForm.querySelector('[role=status]').textContent = errorText(error); }
    finally { savePrompt.disabled = cancel.disabled = false; }
  };

  async function refreshPrompts() {
    try {
      const rows = await prompts.list();
      if (!rows.length) return empty(promptList, '还没有提示词。');
      promptList.replaceChildren(...rows.map(record => {
        const row = item('div', 'wb-home-row');
        const copy = button(record.title, async () => {
          try { await clipboard.writeText(record.body); notice('已复制提示词。'); }
          catch (error) { notice(errorText(error), true); }
        }, 'wb-button wb-home-row-main');
        copy.append(item('small', '', record.body.split(/\r?\n/, 1)[0]));
        copy.title = '复制「' + record.title + '」';
        row.append(copy, button('编辑', () => editPrompt(record)));
        return row;
      }));
    } catch { empty(promptList, '读取提示词失败。'); }
  }

  async function refreshRecent() {
    const revision = ++recentRevision;
    try {
      const rows = await clipboard.invoke('history.search', { limit: 10 });
      if (recentRevision !== revision) return;
      if (!rows.length) return empty(recentList, '还没有剪贴记录。');
      recentList.replaceChildren(...rows.map(record => button(record.preview || (record.type === 'image' ? '图片' : '剪贴记录'), async () => {
        try { await clipboard.invoke('history.copy', { id: record.id }); notice('已复制剪贴记录。'); }
        catch (error) { notice(errorText(error), true); }
      }, 'wb-button wb-home-row-main')));
    } catch { if (recentRevision === revision) empty(recentList, '剪贴板暂不可用。'); }
  }

  function renderPlan({ date, tasks }) {
    if (getWorkDate() !== date) return;
    const signature = JSON.stringify([date, tasks]);
    if (signature === planSignature) return;
    planSignature = signature;
    if (!tasks.length) return empty(todoList, '今天还没有待办。');
    todoList.replaceChildren(...tasks.map(task => {
      const label = item('label', 'wb-home-todo');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = task.done;
      check.onchange = () => {
        const done = check.checked;
        if (planBusy) { check.checked = task.done; return; }
        void mutatePlan({ action: 'toggle', id: task.id, done }, date).then(ok => {
          if (!ok) check.checked = task.done;
        });
      };
      label.append(check, item('span', '', task.text));
      return label;
    }));
  }

  async function mutatePlan(input, date) {
    planBusy = true;
    planRevision++;
    try {
      renderPlan(await workbench.mutatePlan({ period: 'day', date, ...input }));
      return true;
    } catch (error) { notice(errorText(error), true); return false; }
    finally { planBusy = false; if (getWorkDate() !== date) void refreshPlan(); }
  }

  async function refreshPlan() {
    if (planBusy) return;
    const revision = ++planRevision;
    try {
      const result = await workbench.getPlan({ period: 'day', date: getWorkDate() });
      if (revision === planRevision) renderPlan(result);
    } catch {
      if (revision === planRevision) { planSignature = undefined; empty(todoList, '读取待办失败。'); }
    }
  }

  todoForm.onsubmit = async event => {
    event.preventDefault();
    const field = todoForm.elements.text;
    if (planBusy || !field.value.trim()) return;
    const original = field.value;
    if (await mutatePlan({ action: 'add', text: original }, getWorkDate()) && field.value === original) field.value = '';
  };

  const unsubscribe = clipboard.onChanged(() => { if (isActive()) void refreshRecent(); });
  const ticker = setInterval(() => { if (isActive()) updateClock(); }, 1000);
  return {
    open() { updateClock(); return Promise.all([refreshPrompts(), refreshRecent(), refreshPlan()]); },
    refreshPlan,
    dispose() { clearInterval(ticker); unsubscribe(); },
  };
}
