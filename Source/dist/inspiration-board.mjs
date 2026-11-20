export function setupInspirationBoard(panel, { api, notice, errorText, selectAnchor }) {
  panel.innerHTML = `
    <header class="wb-heading">
      <div><h2>灵感板</h2><p>收藏作品截图，记下特点和可以借鉴的做法。</p></div>
      <button class="wb-button wb-primary" type="button" data-board-new>＋ 新建灵感</button>
    </header>
    <div class="wb-board-layout">
      <section class="wb-panel wb-board-gallery" aria-label="灵感卡片">
        <div class="wb-board-toolbar"><input type="search" data-board-search placeholder="搜索标题、网址和灵感" aria-label="搜索灵感卡片"><span class="wb-muted" data-board-count></span></div>
        <div class="wb-board-cards" data-board-cards></div>
      </section>
      <section class="wb-panel wb-board-editor">
        <div class="wb-section-heading"><h2 data-board-editor-title>新建灵感</h2></div>
        <form class="wb-form" data-board-form>
          <label>标题<input name="title" maxlength="300" required placeholder="给这张灵感卡起个名字"></label>
          <label>关联网址 <span class="wb-muted">可选</span><input name="url" type="url" placeholder="https://..."></label>
          <div class="wb-board-image-box">
            <div data-board-image-preview class="wb-board-image-preview"><span>添加一张作品截图</span></div>
            <div class="wb-inline-actions"><button class="wb-button" type="button" data-board-image>选择图片</button><button class="wb-button" type="button" data-board-image-clear hidden>移除图片</button></div>
          </div>
          <label>它特别在哪<textarea name="special" rows="4" maxlength="20000" placeholder="记录让你觉得特别的部分"></textarea></label>
          <label>我能借鉴什么<textarea name="borrow" rows="4" maxlength="20000" placeholder="留下可以带回自己项目的做法"></textarea></label>
          <div class="wb-form-footer"><span class="wb-result" role="status" data-board-message></span><button class="wb-button wb-primary" type="submit">保存灵感</button></div>
        </form>
      </section>
    </div>`;

  const $ = selector => panel.querySelector(selector);
  const form = $('[data-board-form]');
  const fields = form.elements;
  const cards = $('[data-board-cards]');
  const imagePreview = $('[data-board-image-preview]');
  let selected = null;
  let attachment = null;
  let all = [];
  let filterTimer, dirty = false, saving = false, picking = false, generation = 0;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const setMessage = (text, failed = false) => {
    const message = $('[data-board-message]');
    message.textContent = text;
    message.classList.toggle('wb-error', failed);
  };
  const imageUrl = id => `/api/workbench/inspiration-image/${encodeURIComponent(id)}`;

  function previewImage(item) {
    imagePreview.replaceChildren();
    if (item?.id) {
      const image = document.createElement('img');
      image.src = imageUrl(item.id);
      image.alt = item.name || '灵感作品截图';
      image.onerror = () => { imagePreview.replaceChildren(el('span', '', '图片无法读取，请重新选择')); };
      imagePreview.append(image);
    } else imagePreview.append(el('span', '', '添加一张作品截图'));
    $('[data-board-image-clear]').hidden = !item;
  }

  function edit(item = null) {
    selected = item;
    form.reset();
    fields.title.value = item?.title ?? '';
    fields.url.value = item?.url ?? '';
    fields.special.value = item?.special ?? '';
    fields.borrow.value = item?.borrow ?? '';
    attachment = item?.imageAttachmentId ? { id: item.imageAttachmentId, name: item.imageName ?? '已保存的截图' } : null;
    previewImage(attachment);
    $('[data-board-editor-title]').textContent = item ? '编辑灵感' : '新建灵感';
    setMessage('');
    dirty = false;
  }

  function renderCards() {
    const query = $('[data-board-search]').value.normalize('NFKC').toLocaleLowerCase().trim();
    const terms = query.split(/\s+/).filter(Boolean);
    const shown = all.filter(item => {
      const text = [item.title, item.url, item.special, item.borrow].join(' ').normalize('NFKC').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    $('[data-board-count]').textContent = `${shown.length} 张`;
    cards.replaceChildren(...shown.map(item => {
      const card = el('article', `wb-board-card${selected?.id === item.id ? ' is-selected' : ''}`);
      if (item.imageAttachmentId) {
        const image = document.createElement('img');
        image.className = 'wb-board-card-image';
        image.src = imageUrl(item.imageAttachmentId);
        image.alt = '';
        image.loading = 'lazy';
        card.append(image);
      }
      const body = el('div', 'wb-board-card-body');
      const title = el('button', 'wb-board-card-title', item.title);
      title.type = 'button';
      title.onclick = () => select(item);
      body.append(title);
      if (item.url) {
        const link = el('button', 'wb-board-card-url', item.url);
        link.type = 'button';
        link.onclick = () => api.workbench.openLink(item.url).catch(error => notice(errorText(error), true));
        body.append(link);
      }
      if (item.special) body.append(el('p', 'wb-board-card-copy', item.special));
      if (item.borrow) body.append(el('p', 'wb-board-card-copy wb-board-card-borrow', item.borrow));
      const actions = el('div', 'wb-inline-actions');
      const editButton = el('button', 'wb-button', '编辑');
      editButton.type = 'button';
      editButton.onclick = () => select(item);
      actions.append(editButton);
      body.append(actions);
      card.append(body);
      return card;
    }));
    if (!shown.length) cards.append(el('p', 'wb-empty', query ? '没有匹配的灵感卡片。' : '保存第一张灵感卡片，开始积累视觉和方法参考。'));
  }

  async function load() {
    const token = ++generation;
    try {
      const items = await api.inspiration.list();
      if (token === generation) { all = items; renderCards(); }
    } catch (error) {
      if (token === generation) cards.replaceChildren(el('p', 'wb-empty', errorText(error)));
    }
  }

  function select(item) {
    if (saving || picking || (dirty && !confirm('放弃尚未保存的灵感板修改？'))) return false;
    edit(item);
    renderCards();
    fields.title.focus();
    return true;
  }
  form.oninput = () => { dirty = true; };
  $('[data-board-new]').onclick = () => select(null);
  $('[data-board-image]').onclick = async () => {
    if (picking || saving) return;
    picking = true;
    $('[data-board-image]').disabled = true;
    try {
      const result = await api.inspiration.pickImage();
      if (result) { attachment = result; previewImage(attachment); dirty = true; }
    } catch (error) { notice(errorText(error), true); }
    finally { picking = false; $('[data-board-image]').disabled = false; }
  };
  $('[data-board-image-clear]').onclick = () => { attachment = null; previewImage(null); dirty = true; };
  $('[data-board-search]').oninput = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderCards, 120);
  };
  async function saveCurrent() {
    if (saving || picking) return false;
    if (!form.reportValidity()) return false;
    saving = true;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const result = await api.inspiration.save({
        id: selected?.id, expectedUpdatedAt: selected?.updatedAt,
        title: fields.title.value, url: fields.url.value, special: fields.special.value,
        borrow: fields.borrow.value, imageAttachmentId: attachment?.id ?? null, imageName: attachment?.name ?? '',
      });
      edit(result);
      setMessage('已保存');
      await load();
      return !dirty;
    } catch (error) { setMessage(errorText(error), true); }
    finally { saving = false; submit.disabled = false; }
    return false;
  }
  form.onsubmit = async event => {
    event.preventDefault();
    await saveCurrent();
  };
  return {
    load, isDirty: () => dirty || saving || picking,
    pendingEntries() {
      if (!dirty) return [];
      return [{
        key: `inspiration-board:${selected?.id || 'new'}`,
        label: `灵感 · 灵感板 · ${fields.title.value.trim() || '未命名卡片'}`,
        focus() {
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          fields.title.focus();
        },
        save: saveCurrent,
      }];
    },
    async openResult({ id, anchor }) {
      const item = (await api.inspiration.list()).find(card => card.id === id);
      if (!item) throw new Error('找不到这张灵感板卡片。');
      if (!(dirty && selected?.id === id) && !select(item)) return false;
      [fields.special, fields.borrow, fields.title, fields.url].some(field => selectAnchor?.(field, anchor));
      return true;
    },
  };
}
