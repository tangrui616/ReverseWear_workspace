const labels = { link: '链接', note: '笔记', daily: '日报', weekly: '周报', memo: '备忘', 'weekly-review': '周复盘', experiment: '实验', idea: '灵感', 'inspiration-board': '灵感板', 'link-note': '链接笔记', 'link-snapshot': '网页快照',
  experience: '生活经历', mood: '情绪日记', thinking: '思考页', content: '内容看板', template: '模板', custom: '自定义领域' };
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function mountGlobalSearch({ root = document.body, search, activate }) {
  const dialog = make('dialog', 'wb-global-search');
  dialog.setAttribute('aria-label', '全局搜索');
  dialog.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
  dialog.innerHTML = `
    <form method="dialog" class="wb-global-search-top"><input type="search" data-query placeholder="搜索链接、笔记、实验和灵感…" aria-label="搜索工作台" autocomplete="off"><button type="submit" aria-label="关闭">×</button></form>
    <div class="wb-global-filters">
      <select data-filter="area" aria-label="领域"><option value="">全部领域</option><option value="research">科研</option><option value="content">创作</option><option value="language">语言</option><option value="life">生活</option><option value="emotion">情绪</option><option value="unclassified">未分类</option></select>
      <select data-filter="type" aria-label="类型"><option value="">全部类型</option>${Object.entries(labels).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}</select>
      <input data-filter="tag" placeholder="标签" aria-label="标签">
      <select data-filter="status" aria-label="状态"><option value="">全部状态</option><option value="seed">种子</option><option value="growing">培养中</option><option value="action">行动</option><option value="done">完成</option><option value="fridge">冰箱</option><option value="archived">归档</option><option value="inbox">待整理</option><option value="organized">已整理</option></select>
      <input data-filter="from" type="date" aria-label="起始日期"><input data-filter="to" type="date" aria-label="结束日期">
    </div>
    <div class="wb-global-count" data-count role="status"></div><div class="wb-global-results" data-results></div>
    <aside class="wb-global-backlinks" data-backlinks hidden><strong>反向链接 <button type="button" data-copy-reference>复制当前记录引用</button></strong><div data-backlink-list></div></aside>
    <footer><span>↑↓ 选择　Enter 打开　Esc 关闭</span><span data-timing></span></footer>`;
  root.append(dialog);
  const input = dialog.querySelector('[data-query]');
  const resultList = dialog.querySelector('[data-results]');
  const count = dialog.querySelector('[data-count]');
  const timing = dialog.querySelector('[data-timing]');
  const filters = Object.fromEntries([...dialog.querySelectorAll('[data-filter]')].map(field => [field.dataset.filter, field]));
  let active = -1;
  let rows = [];
  let serial = 0;
  let backlinkRequest = 0;
  let opening = false;

  function getFilters() { return Object.fromEntries(Object.entries(filters).map(([key, field]) => [key, field.value])); }

  async function showBacklinks(item) {
    const token = ++backlinkRequest;
    const area = dialog.querySelector('[data-backlinks]');
    const list = dialog.querySelector('[data-backlink-list]');
    area.hidden = !item?.id;
    if (area.hidden) return;
    const copy = area.querySelector('[data-copy-reference]');
    copy.textContent = '复制当前记录引用';
    copy.onclick = async () => {
      try { await search.copyReference(item.id); copy.textContent = '引用已复制'; }
      catch (error) { count.textContent = String(error?.message ?? error); }
    };
    list.textContent = '正在读取…';
    try {
      const links = await search.backlinks(item.id);
      if (token !== backlinkRequest) return;
      list.replaceChildren(...links.map(link => {
        const row = make('span', 'wb-backlink-row');
        const button = make('button', '', `${link.title} · ${labels[link.type] ?? link.type}`);
        button.type = 'button';
        button.onclick = () => void openResult(link);
        row.append(button);
        return row;
      }));
      if (!links.length) list.textContent = '暂无记录引用此条目。';
    } catch (error) { if (token === backlinkRequest) list.textContent = String(error?.message ?? error); }
  }

  function choose(index) {
    active = rows.length ? Math.max(0, Math.min(rows.length - 1, index)) : -1;
    [...resultList.children].forEach((row, rowIndex) => row.classList.toggle('is-active', rowIndex === active));
    const item = rows[active];
    void showBacklinks(item);
    if (item) item.row.scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    const call = ++serial;
    const query = input.value.trim();
    const selectedFilters = getFilters();
    if (!query && !Object.values(selectedFilters).some(Boolean)) {
      rows = []; active = -1; resultList.replaceChildren(make('p', 'wb-global-empty', '输入关键词搜索 Markdown 内容。'));
      count.textContent = ''; timing.textContent = ''; void showBacklinks(null);
      return;
    }
    count.textContent = '正在搜索…';
    try {
      const result = await search.query({ query, filters: selectedFilters, limit: 80 });
      if (call !== serial) return;
      rows = result.results.map(item => ({ ...item })); active = rows.length ? 0 : -1;
      resultList.replaceChildren();
      if (!rows.length) resultList.append(make('p', 'wb-global-empty', '没有匹配的记录。'));
      rows.forEach((item, index) => {
        const row = make('button', 'wb-global-result'); row.type = 'button';
        const head = make('span', 'wb-global-result-head');
        const title = make('strong', '');
        appendHighlighted(title, item.title, query);
        head.append(title, make('small', '', labels[item.type] ?? item.type));
        const excerpt = make('span', 'wb-global-excerpt');
        appendHighlighted(excerpt, item.excerpt || item.relativePath, query);
        const meta = make('span', 'wb-global-meta', [item.relativePath, item.tags.join(' · ')].filter(Boolean).join('　/　'));
        row.append(head, excerpt, meta); row.onclick = () => { choose(index); void openSelected(); };
        item.row = row; resultList.append(row);
      });
      choose(active);
      count.textContent = result.total > rows.length ? `显示前 ${rows.length} 条，共 ${result.total} 条结果` : `${result.total} 条结果`;
      timing.textContent = `${result.elapsedMs.toFixed(1)} ms`;
    } catch (error) {
      if (call === serial) { count.textContent = String(error?.message ?? error); resultList.replaceChildren(); }
    }
  }

  function debounce() {
    serial++;
    rows = [];
    active = -1;
    resultList.replaceChildren();
    void showBacklinks(null);
    clearTimeout(debounce.timer);
    debounce.timer = setTimeout(run, 120);
  }
  function appendHighlighted(target, text, query) {
    const terms = query.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const folded = text.normalize('NFKC').toLocaleLowerCase();
    const ranges = [];
    for (const term of terms) {
      let start = 0;
      while ((start = folded.indexOf(term, start)) >= 0) { ranges.push([start, start + term.length]); start += term.length; }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start < cursor || start >= text.length) continue;
      target.append(document.createTextNode(text.slice(cursor, start)));
      const mark = make('mark', '', text.slice(start, end)); target.append(mark); cursor = end;
    }
    target.append(document.createTextNode(text.slice(cursor)));
  }
  async function openResult(item) {
    if (!item || opening) return;
    opening = true;
    close();
    try {
      if (await activate(item) !== false) return;
      open();
    } catch (error) {
      open();
      count.textContent = String(error?.message ?? error);
    } finally { opening = false; }
  }
  const openSelected = () => openResult(rows[active]);
  function open() {
    if (!dialog.open && document.querySelector('dialog[open]')) return;
    if (!dialog.open) dialog.showModal();
    input.focus(); input.select();
    void run();
  }
  function close() { if (dialog.open) dialog.close(); }
  input.addEventListener('input', debounce);
  filters.tag.addEventListener('input', debounce);
  for (const field of Object.values(filters)) field.addEventListener('change', debounce);
  dialog.addEventListener('keydown', event => {
    if (event.isComposing || event.target.matches('select,input[type="date"],button:not(.wb-global-result)')) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); choose(active + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); choose(active - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); void openSelected(); }
  });
  window.addEventListener('keydown', event => {
    if (document.documentElement.dataset.startupActive) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.altKey) { event.preventDefault(); open(); }
  });
  root.addEventListener('click', event => { if (event.target.closest('[data-global-search-open]')) open(); });
  return { open, close };
}
