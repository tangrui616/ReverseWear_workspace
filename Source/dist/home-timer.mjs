const pad = value => String(value).padStart(2, '0');

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function makeId() {
  return crypto.randomUUID();
}

export function mountHomeTimer({ root, appendTimeline, notice = () => {} }) {
  const time = root.querySelector('#wb-stopwatch-time');
  const state = root.querySelector('#wb-stopwatch-status');
  const startButton = root.querySelector('#wb-stopwatch-start');
  const pauseButton = root.querySelector('#wb-stopwatch-pause');
  const stopButton = root.querySelector('#wb-stopwatch-stop');
  const dialog = root.querySelector('#wb-stopwatch-dialog');
  const form = dialog.querySelector('[data-stopwatch-form]');
  const input = form.elements.task;
  const error = form.querySelector('[data-stopwatch-error]');
  const cancel = form.querySelector('[data-stopwatch-cancel]');
  let startedAt = null;
  let pendingSegment = null;
  let accumulated = 0;
  let interval = null;
  let stopping = false;
  let saving = false;
  let saveWaiters = [];

  function elapsed(now = Date.now()) {
    return accumulated + (startedAt === null ? 0 : now - startedAt);
  }

  function render() {
    time.value = formatDuration(elapsed());
    time.textContent = time.value;
    startButton.hidden = startedAt !== null;
    pauseButton.hidden = startedAt === null;
    stopButton.hidden = startedAt === null && accumulated === 0 && pendingSegment === null;
    startButton.textContent = pendingSegment ? '记录并继续' : accumulated > 0 ? '继续' : '开始';
    if (startedAt !== null) state.textContent = '正在计时';
    else if (pendingSegment) state.textContent = '有一段时间待记录';
    else if (accumulated > 0) state.textContent = '已暂停';
    else state.textContent = '准备开始';
  }

  function openPrompt(shouldStop) {
    stopping = stopping || shouldStop;
    error.textContent = '';
    dialog.returnValue = '';
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  function beginSegment() {
    const now = Date.now();
    startedAt = now;
    if (!interval) interval = setInterval(render, 250);
    render();
  }

  function pause(shouldStop = false) {
    if (startedAt !== null) {
      const end = new Date(Math.max(Date.now(), startedAt + 1));
      accumulated += end.getTime() - startedAt;
      pendingSegment = { id: makeId(), startAt: new Date(startedAt).toISOString(), endAt: end.toISOString() };
      startedAt = null;
      clearInterval(interval);
      interval = null;
    }
    render();
    if (pendingSegment) openPrompt(shouldStop);
    else if (shouldStop) reset();
  }

  function reset() {
    startedAt = null;
    pendingSegment = null;
    accumulated = 0;
    stopping = false;
    input.value = '';
    if (interval) clearInterval(interval);
    interval = null;
    render();
  }

  startButton.addEventListener('click', () => {
    if (pendingSegment) { openPrompt(false); return; }
    beginSegment();
  });
  pauseButton.addEventListener('click', () => pause(false));
  stopButton.addEventListener('click', () => pause(true));
  function settleSaveWaiters(saved) {
    for (const resolve of saveWaiters.splice(0)) resolve(saved);
  }

  function cancelPrompt() {
    if (saving) return;
    dialog.close('cancel');
    settleSaveWaiters(false);
    render();
  }

  cancel.addEventListener('click', cancelPrompt);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancelPrompt();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!pendingSegment || saving) return;
    const task = input.value.trim();
    if (!task) { error.textContent = '请填写刚才完成的事情。'; input.focus(); return; }
    saving = true;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    cancel.disabled = true;
    try {
      await appendTimeline({ sessionId: pendingSegment.id, ...pendingSegment, task });
      pendingSegment = null;
      input.value = '';
      dialog.close('saved');
      if (stopping) reset();
      settleSaveWaiters(true);
    } catch (saveError) {
      error.textContent = saveError?.message || '时间记录保存失败，请重试。';
      notice(error.textContent, true);
      settleSaveWaiters(false);
    } finally {
      saving = false;
      submit.disabled = false;
      cancel.disabled = false;
      render();
    }
  });
  render();

  return {
    isDirty: () => startedAt !== null || pendingSegment !== null,
    pendingEntries() {
      if (startedAt === null && pendingSegment === null) return [];
      return [{
        key: 'home-timer',
        label: '首页 · 正计时活动记录',
        focus() {
          if (startedAt !== null) pauseButton.focus();
          else openPrompt(false);
        },
        save() {
          if (startedAt !== null) pause(true);
          else openPrompt(true);
          return new Promise(resolve => saveWaiters.push(resolve));
        },
      }];
    },
    dispose() {
      if (interval) clearInterval(interval);
      interval = null;
      if (dialog.open) dialog.close('dispose');
    },
  };
}
