const columns = [
  ['seed', '种子'], ['growing', '培养中'], ['action', '行动'], ['done', '完成'], ['fridge', '冰箱'],
];

export function setupIdeaKanban(container, { api, notice, errorText, getPreferences, onOpen, onIndexChanged }) {
  const element = (tag, className, label) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label != null) node.textContent = label;
    return node;
  };
  const toolbar = element('div', 'wb-kanban-toolbar');
  const info = element('span', 'wb-result');
  info.textContent = '拖动卡片调整状态，也可用卡片上的状态菜单';
  toolbar.append(info);
  const lanes = element('div', 'wb-kanban-lanes');
  const archived = element('details', 'wb-kanban-archive');
  const summary = element('summary', '', '已归档的想法');
  const archiveList = element('div', 'wb-kanban-archive-list');
  archived.append(summary, archiveList);
  container.replaceChildren(toolbar, lanes, archived);
  let generation = 0;

  async function move(item, status, control) {
    if (item.status === status) return;
    if (control) control.disabled = true;
    try {
      if (status === 'action' && getPreferences?.()?.warnActionLimit !== false) {
        const active = await api.listIdeas({ status: 'action' });
        if (active.length >= 3 && !confirm('行动中的想法将超过 3 个，仍要继续吗？')) return;
      }
      await api.saveIdea({ id: item.id, expectedUpdatedAt: item.updatedAt, status });
      await load();
    } catch (error) { notice(errorText(error), true); }
    finally {
      if (control) { control.value = item.status; control.disabled = false; }
    }
  }

  async function load() {
    const token = ++generation;
    const ideas = await api.listIdeas();
    if (token !== generation) return;
    const visible = ideas.filter(item => columns.some(([status]) => status === item.status));
    lanes.replaceChildren(...columns.map(([status, title]) => {
      const lane = element('section', 'wb-kanban-lane');
      lane.dataset.kanbanStatus = status;
      lane.setAttribute('aria-label', title);
      lane.ondragover = event => event.preventDefault();
      lane.ondrop = event => {
        event.preventDefault();
        const item = visible.find(card => card.id === event.dataTransfer?.getData('text/plain'));
        if (item) void move(item, status);
      };
      const heading = element('div', 'wb-kanban-lane-heading');
      heading.append(element('h3', '', title), element('span', 'wb-state', String(visible.filter(item => item.status === status).length)));
      lane.append(heading);
      for (const item of visible.filter(card => card.status === status)) {
        const card = element('article', 'wb-kanban-card');
        card.draggable = true;
        card.dataset.ideaCard = item.id;
        card.ondragstart = event => event.dataTransfer?.setData('text/plain', item.id);
        const open = element('button', 'wb-entry-title', item.title || item.original);
        open.type = 'button';
        open.onclick = () => onOpen(item.id);
        const excerpt = element('p', 'wb-excerpt', item.original);
        const controls = element('div', 'wb-kanban-card-actions');
        const select = document.createElement('select');
        select.setAttribute('aria-label', `更改「${item.title || item.original.slice(0, 24)}」的状态`);
        select.dataset.kanbanStatusSelect = '';
        for (const [value, label] of columns) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          select.append(option);
        }
        select.value = item.status;
        select.onchange = () => void move(item, select.value, select);
        controls.append(select);
        card.append(open, excerpt, controls);
        lane.append(card);
      }
      if (!visible.some(item => item.status === status)) lane.append(element('p', 'wb-empty', '拖入想法卡片'));
      return lane;
    }));
    const archivedItems = ideas.filter(item => item.status === 'archived');
    archiveList.replaceChildren(...archivedItems.map(item => {
      const button = element('button', 'wb-entry-title', item.title || item.original);
      button.type = 'button';
      button.onclick = () => onOpen(item.id);
      return button;
    }));
    if (!archivedItems.length) archiveList.append(element('p', 'wb-empty', '暂无归档想法。'));
  }

  const unsubscribe = onIndexChanged?.(categories => {
    if (!container.closest('[hidden]') && categories.includes('ideas')) void load();
  });
  window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
  return { load };
}
