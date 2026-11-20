import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_PENDING = 64;
const COMMANDS = new Set(['snapshot', 'focus', 'paste', 'copy', 'setFiles', 'selection']);

export async function spawnPersistentBridge(executable, { timeoutMs = 2500, spawnChild = spawn } = {}) {
  if (typeof executable !== 'string' || !executable) throw new TypeError('A Windows bridge executable path is required.');
  const child = spawnChild(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const listeners = new Set();
  const exitListeners = new Set();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let closed = false;
  let stderr = '';

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') {
      readyResolve();
      return;
    }
    if (message.event === 'clipboard-changed') {
      for (const listener of listeners) {
        try { listener(message); } catch { /* A UI subscriber cannot stop clipboard event delivery. */ }
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.once('error', error => {
    readyReject(error);
    rejectPending(error);
  });
  child.once('exit', (code, signal) => {
    closed = true;
    const error = new Error(`Windows helper exited (${code ?? signal ?? 'unknown'})${stderr ? `: ${stderr.trim()}` : ''}`);
    readyReject(error);
    rejectPending(error);
    for (const listener of exitListeners) {
      try { listener(error); } catch { /* A status subscriber cannot affect bridge shutdown. */ }
    }
  });

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function request(command, args = {}) {
    if (!COMMANDS.has(command)) return Promise.reject(new Error('Unsupported Windows helper command.'));
    if (args == null || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new TypeError('Windows helper arguments must be an object.'));
    if (closed || child.stdin.destroyed) return Promise.reject(new Error('Windows helper is closed.'));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Windows helper request queue is full.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Windows helper request timed out: ${command}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ ...args, id, command })}\n`, error => {
        if (!error) return;
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        clearTimeout(item.timeout);
        reject(error);
      });
    });
  }

  let startupTimer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Windows helper did not become ready.')), timeoutMs); }),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  return {
    request,
    onEvent(listener) {
      if (typeof listener !== 'function') throw new TypeError('Clipboard event listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit(listener) {
      if (typeof listener !== 'function') throw new TypeError('Bridge exit listener must be a function.');
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill();
      rejectPending(new Error('Windows helper was closed.'));
      listeners.clear();
      exitListeners.clear();
    },
    get pid() { return child.pid ?? null; },
  };
}

export function createRestartingBridge(executable, { timeoutMs = 2500, onStateChanged = () => {}, spawnChild = spawn,
  retryDelays = [1000, 5000, 30000] } = {}) {
  const eventListeners = new Set();
  let bridge = null;
  let closed = false;
  let retryTimer = null;
  let retryCount = 0;
  let initialAttemptDone;
  const ready = new Promise(resolve => { initialAttemptDone = resolve; });
  let state = { available: false, error: 'Windows 剪贴板助手尚未连接。', attempts: 0 };

  function publish(next) {
    state = next;
    try { onStateChanged(state); } catch { /* Status reporting cannot affect bridge recovery. */ }
  }

  function scheduleRetry(error) {
    bridge = null;
    if (closed) return;
    if (retryCount >= 3) {
      publish({ available: false, error: `Windows 剪贴板助手无法恢复：${error.message}`, attempts: retryCount });
      return;
    }
    const delay = retryDelays[retryCount++];
    publish({ available: false, error: `Windows 剪贴板助手已退出，将在 ${delay / 1000} 秒后重试。`, attempts: retryCount });
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
  }

  async function connect() {
    if (closed || bridge) return;
    try {
      const next = await spawnPersistentBridge(executable, { timeoutMs, spawnChild });
      if (closed) { next.close(); return; }
      bridge = next;
      retryCount = 0;
      next.onEvent(event => { for (const listener of eventListeners) listener(event); });
      next.onExit(scheduleRetry);
      publish({ available: true, error: '', attempts: 0 });
    } catch (error) {
      scheduleRetry(error instanceof Error ? error : new Error(String(error)));
    } finally {
      initialAttemptDone();
    }
  }

  void connect();

  return {
    ready,
    request(command, args) {
      if (!bridge) return Promise.reject(new Error(state.error || 'Windows 剪贴板助手不可用。'));
      return bridge.request(command, args);
    },
    onEvent(listener) {
      if (typeof listener !== 'function') throw new TypeError('Clipboard event listener must be a function.');
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getState: () => state,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      bridge?.close();
      bridge = null;
      eventListeners.clear();
    },
  };
}
