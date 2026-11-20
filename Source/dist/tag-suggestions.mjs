const separators = /[,，;；、\n]/;

function makeOption(tag, selected) {
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'tag-suggestions__option';
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', String(selected));
  option.textContent = tag;
  return option;
}

function activeToken(input) {
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  let start = 0;
  let end = value.length;
  for (let index = caret - 1; index >= 0; index -= 1) {
    if (separators.test(value[index])) { start = index + 1; break; }
  }
  for (let index = caret; index < value.length; index += 1) {
    if (separators.test(value[index])) { end = index; break; }
  }
  return { start, end, query: value.slice(start, caret).trim() };
}

export function mountTagSuggestions(input, { listRecent, maxItems = 10 } = {}) {
  if (!(input instanceof HTMLInputElement) || typeof listRecent !== 'function') {
    throw new TypeError('标签建议需要文本输入框和最近标签读取方法。');
  }

  const host = document.createElement('span');
  host.className = 'tag-suggestions';
  input.before(host);
  host.append(input);
  const list = document.createElement('div');
  list.className = 'tag-suggestions__list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  host.append(list);
  const listId = `tag-suggestions-${crypto.randomUUID()}`;
  list.id = listId;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let options = [];
  let activeIndex = -1;
  let composing = false;
  let revision = 0;
  let inserting = false;

  function close() {
    revision++;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  async function refresh() {
    if (!input.isConnected || composing || inserting) return;
    const tokenId = ++revision;
    let recent = [];
    try { recent = await listRecent(); }
    catch { if (tokenId === revision) close(); return; }
    if (tokenId !== revision) return;
    const token = activeToken(input);
    const query = token.query.toLocaleLowerCase('zh-CN');
    options = [...new Set((Array.isArray(recent) ? recent : []).filter(value => typeof value === 'string'))]
      .filter(value => !query || value.toLocaleLowerCase('zh-CN').includes(query))
      .slice(0, Math.min(10, maxItems));
    if (!options.length || document.activeElement !== input) { close(); return; }
    activeIndex = -1;
    list.replaceChildren(...options.map((tag, index) => {
      const option = makeOption(tag, index === activeIndex);
      option.id = listId + '-' + index;
      return option;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function choose(index) {
    const tag = options[index];
    if (!tag) return;
    const token = activeToken(input);
    const before = input.value.slice(0, token.start);
    const after = input.value.slice(token.end);
    const suffix = after && !separators.test(after[0]) ? '，' : '';
    const inserted = `${tag}${suffix}`;
    input.value = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    input.setSelectionRange(caret, caret);
    inserting = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    inserting = false;
    close();
  }

  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; void refresh(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing) return;
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' && !list.hidden) {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
    } else if (event.key === 'ArrowUp' && !list.hidden) {
      event.preventDefault();
      activeIndex = (activeIndex <= 0 ? options.length : activeIndex) - 1;
    } else if (event.key === 'Enter' && !list.hidden && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
      return;
    } else return;
    [...list.children].forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === activeIndex));
    });
    input.setAttribute('aria-activedescendant', list.children[activeIndex].id);
    list.children[activeIndex].scrollIntoView({ block: 'nearest' });
  });
  list.addEventListener('pointerdown', event => {
    const option = event.target.closest('[role="option"]');
    if (!option) return;
    event.preventDefault();
    choose([...list.children].indexOf(option));
    input.focus();
  });

  return { close };
}
