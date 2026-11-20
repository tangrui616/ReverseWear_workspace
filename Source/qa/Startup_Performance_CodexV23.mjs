import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function availablePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connectTarget(port, child, deadline) {
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) });
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page' && item.url.startsWith('https://stilltime-app.invalid/'));
      if (target) return target;
    } catch { /* Chromium's debugging endpoint starts after the process. */ }
    await delay(15);
  }
  throw new Error('启动计时未找到工作台窗口。');
}

async function measure(binary, output, attempt, waitForStage) {
  const port = await availablePort();
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const child = spawn(binary, ['--verify-portable', '--startup-timing', `--remote-debugging-port=${port}`], {
    windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary),
  });
  const chunks = [];
  child.stdout.on('data', data => chunks.push(data.toString()));
  child.stderr.on('data', data => chunks.push(data.toString()));
  let launchError;
  child.on('error', error => { launchError = error; });
  let socket;
  let send;
  try {
    const target = await connectTarget(port, child, startedAt + 20_000);
    if (launchError) throw launchError;
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await Promise.race([
      once(socket, 'open'),
      delay(5000).then(() => { if (socket.readyState !== 1) throw new Error('启动计时 CDP 连接超时。'); }),
    ]);
    const requests = new Map();
    let serial = 0;
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.consoleAPICalled') {
        chunks.push('\nRenderer ' + message.params.type + ': ' + message.params.args.map(item => item.value ?? item.description ?? '').join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') chunks.push('\nRenderer exception: ' + JSON.stringify(message.params.exceptionDetails));
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`启动计时 CDP 超时 ${method}`));
      }, 5000);
      requests.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    const evaluate = async expression => {
      const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || JSON.stringify(answer.exceptionDetails));
      return answer.result.value;
    };
    const read = () => evaluate(`(() => {
      const mark = name => performance.getEntriesByName('reversewear:' + name).at(-1)?.startTime;
      const button = document.getElementById('st-skip');
      const rect = button?.getBoundingClientRect();
      return { origin: performance.timeOrigin, ui: mark('ui-ready'), stage: mark('stage-ready'),
        skipped: mark('skip-requested'), active: !!document.documentElement?.dataset.startupActive,
        usable: button && !button.hidden && !button.disabled && rect.width > 0,
        point: rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
    })()`);
    let state;
    let shownAt;
    while (elapsed() < 15_000) {
      state = await read();
      const shown = chunks.join('').match(/STARTUP_WINDOW_VISIBLE (\d+)/);
      shownAt = shown ? Number(shown[1]) : undefined;
      if (shownAt && state.usable && Number.isFinite(state.ui)) break;
      await delay(10);
    }
    assert.ok(shownAt && state?.usable && Number.isFinite(state.ui), '可见窗口的轻量开屏与跳过按钮未就绪。');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const uiMs = elapsed();
    const shellReadyMs = Math.round(state.origin + state.ui - startedAt);
    if (waitForStage) {
      while (elapsed() < 15_000 && !Number.isFinite(state.stage)) {
        await delay(10);
        state = await read();
      }
    }
    if (waitForStage) assert.ok(Number.isFinite(state.stage), '完整三维开屏未就绪。');
    if (attempt === 1 || waitForStage) {
      const snapshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(output, waitForStage ? 'Startup_Stage_CodexV23.png' : 'Startup_First_Frame_CodexV23.png'), Buffer.from(snapshot.data, 'base64'));
    }
    const inputAt = elapsed();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...state.point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...state.point });
    let after;
    while (elapsed() < inputAt + 8000) {
      after = await read();
      if (Number.isFinite(after.skipped) && !after.active) break;
      await delay(10);
    }
    assert.ok(Number.isFinite(after?.skipped) && !after.active, '真实鼠标输入未完成开屏跳过。');
    // A second observation catches late asynchronous stage attachment after cancellation.
    await delay(250);
    assert.equal((await read()).active, false, '取消后开屏重新挂载。');
    const skipAcknowledgedMs = Math.round(after.origin + after.skipped - startedAt);
    return {
      attempt, mode: waitForStage ? 'full-stage' : 'early-skip',
      windowMs: shownAt - startedAt,
      uiMs, shellReadyMs, stageMs: Number.isFinite(state.stage) ? Math.round(state.origin + state.stage - startedAt) : null,
      inputMs: inputAt, skipAcknowledgedMs, skipLatencyMs: Math.max(0, skipAcknowledgedMs - inputAt),
      interactiveMs: elapsed() - 250,
      passed: uiMs <= 3000 && (skipAcknowledgedMs - inputAt) <= 500 && (waitForStage || skipAcknowledgedMs <= 3000),
    };
  } finally {
    if (socket?.readyState === 1) await send?.('Browser.close').catch(() => {});
    socket?.close();
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), delay(1500)]);
      if (child.exitCode === null) {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await once(cleanup, 'exit');
      }
    }
    await writeFile(path.join(output, `startup-${attempt}.log`), chunks.join(''));
  }
}

const [binary, destination, count = '6'] = process.argv.slice(2);
assert.ok(binary && destination, '用法 node qa/Startup_Performance_CodexV23.mjs <目录版EXE> <全新报告目录> [启动次数]');
const output = path.resolve(destination);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const measurements = [];
let failure;
try {
  for (let attempt = 1; attempt <= Number(count); attempt++) {
    const result = await measure(path.resolve(binary), output, attempt, false);
    measurements.push(result);
    console.log(JSON.stringify(result));
  }
  const stage = await measure(path.resolve(binary), output, 'stage', true);
  measurements.push(stage);
  console.log(JSON.stringify(stage));
} catch (error) {
  failure = error.stack;
  console.error(failure);
}
const passed = !failure && measurements.every(item => item.passed) && measurements.length === Number(count) + 1;
const report = [
  'task: V23 目录便携版开屏启动性能验收',
  `status: ${passed ? 'done' : 'blocked'}`,
  `updated: ${new Date().toISOString().slice(0, 10)}`,
  `done: ${JSON.stringify([`已完成 ${measurements.length} 次隔离启动计时。`])}`,
  'todo: []',
  `blocked: ${JSON.stringify(passed ? [] : [failure || '部分启动样本超过 3 秒或跳过响应超过 500 毫秒。'])}`,
  `decisions: ${JSON.stringify(['前六次使用真实鼠标提前跳过，额外一次记录完整三维初始化。', '每次使用全新隔离数据和 Chromium 配置。'])}`,
  `files: ${JSON.stringify([path.resolve(binary)])}`,
  `next_action: ${JSON.stringify(passed ? '按发布流程核对桌面入口。' : '根据计时与日志定位超时阶段。')}`,
  'measurements:',
  ...measurements.map(item => '  - ' + JSON.stringify(item)),
];
await writeFile(path.join(output, 'Startup_Performance_CodexV23.yaml'), report.join('\n') + '\n');
process.exitCode = passed ? 0 : 1;
