export function setupWindowControls(api) {
  const controls = document.querySelectorAll('[data-window-command]');
  const applyState = ({ maximized, fullscreen }) => {
    const expanded = maximized || fullscreen;
    document.documentElement.classList.toggle('window-flush', expanded);
    const maximize = document.querySelector('[data-window-command="maximize"]');
    maximize.setAttribute('aria-label', expanded ? '还原窗口' : '最大化窗口');
    maximize.title = maximize.getAttribute('aria-label');
  };
  for (const control of controls) control.onclick = () => {
    void api.control(control.dataset.windowCommand).catch(console.error);
  };
  api.onState(applyState);
  void api.ready().then(applyState).catch(console.error);
}

export function setupQuitDialog({ api, root, collect, notice }) {
  const heading = root.querySelector('h2');
  const description = root.querySelector('p');
  const buttons = root.querySelector('[data-quit-actions]');
  const targets = root.querySelector('[data-quit-targets]');
  const view = root.querySelector('[data-quit-view]');
  const save = root.querySelector('[data-quit-save]');
  let request;
  let queuedRequest;
  let controlledCloses = 0;

  function hidePrompt() {
    if (!root.open) return;
    controlledCloses++;
    root.close();
  }

  async function settle(close) {
    const id = request;
    if (!id) return;
    hidePrompt();
    try { await api.quitResult(id, close); }
    finally {
      if (request === id) request = undefined;
      if (queuedRequest !== undefined && request === undefined) {
        const next = queuedRequest;
        queuedRequest = undefined;
        void handleQuitRequest(next);
      }
    }
  }

  function render(entries, showTargets = false) {
    heading.textContent = '你有 ' + entries.length + ' 项修改尚未保存';
    description.textContent = showTargets ? '选择要返回的内容。' : '可以保存全部修改后关闭工作台，或返回查看。';
    buttons.hidden = showTargets;
    targets.hidden = !showTargets;
    targets.replaceChildren();
    if (!showTargets) return;
    for (const item of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.quitTarget = item.key;
      const label = document.createElement('strong');
      label.textContent = item.label || '未命名草稿';
      const location = document.createElement('span');
      location.textContent = item.location;
      button.append(label, location);
      button.onclick = async () => {
        try { await settle(false); await item.focus(); }
        catch (error) { notice(error.message, true); }
      };
      targets.append(button);
    }
    targets.firstElementChild?.focus();
  }

  root.addEventListener('close', () => {
    if (controlledCloses > 0) {
      controlledCloses--;
      return;
    }
    void settle(false).catch(console.error);
  });
  root.addEventListener('cancel', event => {
    event.preventDefault();
    void settle(false).catch(console.error);
  });
  view.onclick = async () => {
    try {
      const entries = collect();
      if (entries.length > 1) render(entries, true);
      else {
        await settle(false);
        await entries[0]?.focus();
      }
    } catch (error) { notice(error.message, true); }
  };
  save.onclick = async () => {
    if (!request) return;
    hidePrompt();
    let item;
    try {
      for (const entry of collect()) {
        item = entry;
        if (await entry.save()) continue;
        await settle(false);
        if (entry.focusAfterSaveFailure !== false) await entry.focus();
        return;
      }
      const remaining = collect();
      if (remaining.length) {
        render(remaining);
        root.showModal();
        return;
      }
      await settle(true);
    } catch (error) {
      await settle(false);
      await item?.focus();
      notice(error.message || '保存失败，请重试。', true);
    }
  };
  async function handleQuitRequest(id) {
    if (request) { queuedRequest = id; return; }
    request = id;
    try {
      const entries = collect();
      if (entries.length === 0) { await settle(true); return; }
      render(entries);
      root.showModal();
      view.focus();
    } catch (error) {
      await settle(false);
      notice(error.message || '无法检查未保存的内容。', true);
    }
  }
  api.onQuitRequest(handleQuitRequest);
}
