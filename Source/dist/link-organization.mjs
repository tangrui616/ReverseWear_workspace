function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(label, callback, className = 'wb-button') {
  const result = element('button', className, label);
  result.type = 'button';
  result.onclick = callback;
  return result;
}

export function mountLinkOrganization({ panel, api, notify, refresh }) {
  const root = element('section', 'wb-link-organization');
  root.innerHTML = `
    <div class="wb-link-org-toolbar">
      <label class="wb-link-org-select"><input type="checkbox" data-select-visible><span data-selected-count>已选 0 项</span></label>
      <div class="wb-link-org-actions">
        <button class="wb-button" type="button" data-bulk-tags>批量加标签</button>
        <button class="wb-button" type="button" data-check-links>检查所选链接</button>
        <button class="wb-button" type="button" data-tag-tools>标签与重复项</button>
        <button class="wb-button" type="button" data-undo hidden>撤销上次整理</button>
      </div>
    </div>
    <div class="wb-link-org-panel" data-bulk-panel hidden>
      <label>添加标签<input type="text" data-bulk-tag-value placeholder="例如：研究/语音、待精读"></label>
      <button class="wb-button wb-primary" type="button" data-apply-tags>应用到所选</button>
    </div>
    <div class="wb-link-org-panel wb-link-org-tools" data-tools-panel hidden>
      <div class="wb-link-org-tool-column"><h3>标签管理</h3><div data-tags></div></div>
      <div class="wb-link-org-tool-column"><h3>重复网址</h3><div data-duplicates></div></div>
    </div>
    <div class="wb-link-org-results" data-check-results hidden></div>`;

  const list = panel.querySelector('[data-link-list]');
  list.before(root);
  const selected = new Set();
  const knownItems = new Map();
  let visibleItems = [];
  const selectVisible = root.querySelector('[data-select-visible]');
  const selectedCount = root.querySelector('[data-selected-count]');
  const undoButton = root.querySelector('[data-undo]');
  const bulkPanel = root.querySelector('[data-bulk-panel]');
  const toolsPanel = root.querySelector('[data-tools-panel]');
  const checkResults = root.querySelector('[data-check-results]');
  let organizationCache;
  let organizationRequest;

  async function getOrganizationData() {
    if (!organizationRequest) {
      const request = api.listLinks().then(data => {
        if (organizationRequest === request) {
          organizationCache = data;
          setUndoAvailable(data.canUndo);
        }
        return data;
      }).catch(error => {
        if (organizationRequest === request) organizationRequest = null;
        throw error;
      });
      organizationRequest = request;
    }
    return organizationCache ?? organizationRequest;
  }

  function invalidateOrganizationData() {
    organizationCache = null;
    organizationRequest = null;
  }

  function updateSelection() {
    selectedCount.textContent = `已选 ${selected.size} 项`;
    selectVisible.checked = visibleItems.length > 0 && visibleItems.every(item => selected.has(item.id));
    selectVisible.indeterminate = !selectVisible.checked && visibleItems.some(item => selected.has(item.id));
    for (const box of list.querySelectorAll('[data-link-select]')) box.checked = selected.has(box.value);
  }

  function selectionControl(item) {
    knownItems.set(item.id, item);
    const label = element('label', 'wb-link-select-control');
    label.title = '选择链接';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = item.id;
    input.dataset.linkSelect = '';
    input.checked = selected.has(item.id);
    input.setAttribute('aria-label', `选择 ${item.title || item.url}`);
    input.onchange = () => {
      if (input.checked) selected.add(item.id);
      else selected.delete(item.id);
      updateSelection();
    };
    label.append(input);
    return label;
  }

  function setVisibleItems(items) {
    visibleItems = items;
    items.forEach(item => knownItems.set(item.id, item));
    updateSelection();
  }

  async function refreshUndoState() {
    const data = await getOrganizationData();
    setUndoAvailable(data.canUndo);
  }

  function setUndoAvailable(available) { undoButton.hidden = available !== true; }

  async function runOperation(operation) {
    try { return await operation(); }
    catch (error) { notify(error?.message || String(error), true); return null; }
  }

  selectVisible.onchange = () => {
    if (selectVisible.checked) visibleItems.forEach(item => selected.add(item.id));
    else visibleItems.forEach(item => selected.delete(item.id));
    updateSelection();
  };

  root.querySelector('[data-bulk-tags]').onclick = () => {
    bulkPanel.hidden = !bulkPanel.hidden;
    if (!bulkPanel.hidden) bulkPanel.querySelector('input').focus();
  };
  root.querySelector('[data-apply-tags]').onclick = () => runOperation(async () => {
    const tags = [...new Set(bulkPanel.querySelector('[data-bulk-tag-value]').value.split(/[,，、;；\n]+/).map(value => value.trim()).filter(Boolean))];
    if (!selected.size || !tags.length) return;
    const result = await api.bulkTag({ ids: [...selected], add: tags });
    notify(`已为 ${result.changed} 条链接添加标签`);
    bulkPanel.querySelector('[data-bulk-tag-value]').value = '';
    invalidateOrganizationData();
    undoButton.hidden = false;
    await refresh();
  });

  root.querySelector('[data-check-links]').onclick = async event => {
    if (!selected.size) { notify('请先选择要检查的链接'); return; }
    const trigger = event.currentTarget;
    trigger.disabled = true;
    const selectedIds = [...selected];
    try {
      const rows = [];
      for (let start = 0; start < selectedIds.length; start += 30) {
        trigger.textContent = `正在检查 ${Math.min(start + 30, selectedIds.length)}/${selectedIds.length}…`;
        rows.push(...await api.check({ ids: selectedIds.slice(start, start + 30) }));
      }
      checkResults.hidden = false;
      checkResults.replaceChildren(element('h3', '', '链接检查结果'));
      for (const row of rows) {
        const item = knownItems.get(row.id);
        const line = element('div', 'wb-link-check-row');
        const name = element('span', 'wb-link-check-name', item?.title || item?.url || row.id);
        const state = ({ reachable: '可访问', redirect: '已跳转', dead: `失效 · HTTP ${row.httpStatus ?? ''}`, unknown: '暂无法判断' })[row.status] || '暂无法判断';
        line.append(name, element('span', `wb-link-check-state is-${row.status || 'unknown'}`, state));
        if (row.destination) line.append(element('small', 'wb-link-check-destination', row.destination));
        if (row.detail) line.append(element('small', 'wb-link-check-detail', row.detail));
        checkResults.append(line);
      }
      notify(`已完成 ${rows.length} 条链接检查`);
    } catch (error) { notify(error?.message || String(error), true); }
    finally { trigger.disabled = false; trigger.textContent = '检查所选链接'; }
  };

  root.querySelector('[data-tag-tools]').onclick = () => runOperation(async () => {
    toolsPanel.hidden = !toolsPanel.hidden;
    if (!toolsPanel.hidden) await loadTools();
    await refreshUndoState();
  });
  root.querySelector('[data-undo]').onclick = () => runOperation(async () => {
    const result = await api.undo();
    if (result.undone) {
      notify('已撤销上次整理');
      undoButton.hidden = true;
    } else if (result.conflicts?.length) {
      notify(`检测到外部修改，未撤销：${result.conflicts.join('、')}`, true);
    } else {
      notify('没有可撤销的批量整理');
      undoButton.hidden = true;
    }
    invalidateOrganizationData();
    await refresh();
    if (!toolsPanel.hidden) await loadTools();
    await refreshUndoState();
  });

  async function loadTools() {
    const data = await getOrganizationData();
    setUndoAvailable(data.canUndo);
    const tags = root.querySelector('[data-tags]');
    const duplicates = root.querySelector('[data-duplicates]');
    tags.replaceChildren();
    duplicates.replaceChildren();
    if (!data.tags.length) tags.append(element('p', 'wb-link-org-muted', '还没有标签。'));
    for (const tag of data.tags) {
      const row = element('div', 'wb-link-tag-row');
      const name = element('strong', '', tag.name);
      const details = element('small', '', tag.aliases?.length ? `别名：${tag.aliases.join('、')}` : '暂无别名');
      const controls = element('div', 'wb-link-org-actions');
      const editor = element('div', 'wb-link-tag-editor');
      const renameInput = document.createElement('input');
      renameInput.value = tag.name;
      renameInput.setAttribute('aria-label', `重命名标签 ${tag.name}`);
      const aliasInput = document.createElement('input');
      aliasInput.value = (tag.aliases || []).join('，');
      aliasInput.setAttribute('aria-label', `${tag.name} 的别名，用逗号分隔`);
      editor.hidden = true;
      const rename = button('重命名', () => runOperation(async () => {
        const next = renameInput.value.trim();
        if (!next) { notify('标签名称不能为空', true); return; }
        const result = await api.renameTag({ from: tag.name, to: next });
        invalidateOrganizationData();
        await refresh();
        notify(`已更新 ${result.changed} 条链接`);
        await loadTools();
      }));
      const saveAliases = button('保存别名', () => runOperation(async () => {
        await api.saveTagAliases({ tag: tag.name, aliases: aliasInput.value.split(/[,，、;；]+/).map(value => value.trim()).filter(Boolean) });
        invalidateOrganizationData();
        await refresh();
        notify('标签别名已保存');
        await loadTools();
      }));
      editor.append(renameInput, rename, aliasInput, saveAliases);
      controls.append(button('编辑', () => { editor.hidden = !editor.hidden; renameInput.focus(); }));
      row.append(name, details, controls, editor);
      tags.append(row);
    }
    if (!data.duplicateGroups.length) duplicates.append(element('p', 'wb-link-org-muted', '没有重复网址。'));
    for (const group of data.duplicateGroups) {
      const row = element('div', 'wb-link-duplicate-row');
      row.append(element('strong', '', `${group.items.length} 条记录`), element('small', '', group.canonicalUrl));
      const select = document.createElement('select');
      select.setAttribute('aria-label', '选择主要链接记录');
      for (const link of group.items) {
        const option = document.createElement('option');
        option.value = link.id;
        option.textContent = `${link.title || link.url}${link.id === group.primaryId ? ' · 主要' : ''}`;
        option.selected = link.id === group.primaryId;
        select.append(option);
      }
      select.onchange = () => runOperation(async () => {
        await api.setPrimary({ canonicalUrl: group.canonicalUrl, primaryId: select.value });
        invalidateOrganizationData();
        undoButton.hidden = false;
        notify('主要链接已更新，其他记录和笔记均保留');
        await refresh();
        await loadTools();
      });
      row.append(select);
      duplicates.append(row);
    }
  }

  panel.addEventListener('click', event => {
    if (event.target.closest('[data-link-reload]')) void runOperation(async () => {
      invalidateOrganizationData();
      await loadToolsIfOpen();
    });
  });
  async function loadToolsIfOpen() { if (!toolsPanel.hidden) await loadTools(); }
  async function refreshData() {
    invalidateOrganizationData();
    return getOrganizationData();
  }
  return { selectionControl, setVisibleItems, refreshUndoState, setUndoAvailable, getOrganizationData, refreshData };
}
