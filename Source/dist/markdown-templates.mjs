function insertTemplate(target, content) {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  const prefix = target.value.slice(0, start);
  const suffix = target.value.slice(end);
  const before = prefix && !prefix.endsWith('\n') ? '\n\n' : '';
  const after = suffix && !suffix.startsWith('\n') ? '\n\n' : '';
  const inserted = before + content.trimEnd() + after;
  target.value = prefix + inserted + suffix;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
  const cursor = prefix.length + inserted.length;
  target.setSelectionRange(cursor, cursor);
}

export function addMarkdownTemplatePicker(target, api = window.stilltimeDesktop.life, onError = () => {}) {
  const picker = document.createElement('details');
  picker.className = 'wb-note-template';
  const insertOnSelect = target.matches('[data-nw-body]');
  picker.innerHTML = '<summary>插入 Markdown 模板</summary><label>从模板库选择<select><option value="">选择模板</option></select></label><button type="button" class="wb-button"' + (insertOnSelect ? ' hidden' : '') + '>插入正文</button>';
  const label = target.closest('label');
  if (label) label.after(picker);
  else target.after(picker);
  const select = picker.querySelector('select');
  let templates = [];
  picker.addEventListener('toggle', async () => {
    if (!picker.open) return;
    try {
      templates = await api.list({ kind: 'template' });
      select.replaceChildren(new Option(templates.length ? '选择模板' : '请先在生活与思考中创建模板', ''));
      for (const template of templates) select.append(new Option(template.title, template.id));
    } catch (error) { onError(error); }
  });
  function applySelectedTemplate() {
    const template = templates.find(item => item.id === select.value);
    const content = template?.fields?.templateBody ?? template?.body;
    if (!content?.trim()) return;
    insertTemplate(target, content);
    picker.open = false;
  }
  select.onchange = () => { if (insertOnSelect && select.value) applySelectedTemplate(); };
  picker.querySelector('button').onclick = applySelectedTemplate;
  return picker;
}
