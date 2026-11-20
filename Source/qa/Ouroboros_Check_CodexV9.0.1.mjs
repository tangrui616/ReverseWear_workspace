import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, nativeTheme } from 'electron';

const APP = 'https://stilltime-app.invalid';
const OURO = 'https://stilltime-ouroboros.invalid';

export function ouroborosFrame(win) {
  return win.webContents.mainFrame.framesInSubtree.find(frame =>
    frame?.url.split('?')[0] === OURO + '/Ouroboros_Infinite_Loop_V9.html');
}

export async function readOuroboros(win, expression) {
  const frame = ouroborosFrame(win);
  if (!frame) return null;
  let timeout;
  try {
    return await Promise.race([
      frame.executeJavaScript(expression, true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); }),
    ]);
  } catch (error) {
    if (frame === ouroborosFrame(win)) throw error;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForOuroboros(check, description) {
  const deadline = Date.now() + 25000;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + description);
}

export async function runOuroborosCheck(win) {
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root, 'Use an isolated data root');
  const inspect = expression => win.webContents.executeJavaScript(expression, true);
  const scene = expression => readOuroboros(win, expression);
  const click = selector => inspect(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settled = async night => {
    try {
      await waitForOuroboros(() => scene(`window.__frames > 5 && __ouro.S.night === ${night} && Math.abs(__ouro.S.nightV - ${Number(night)}) < .08`), `rendering settled to ${night ? 'night' : 'day'}`);
    } catch (error) {
      console.error('Scene state:', await scene('({ origin, frames: window.__frames, night: window.__ouro?.S.night, blend: window.__ouro?.S.nightV })'));
      throw error;
    }
  };
  const mode = async value => {
    await inspect(`if (document.querySelector('#wb-appearance-panel').hidden) document.querySelector('#wb-appearance').click()`);
    await click(`[data-mode-choice=${value}]`);
    await click('#wb-appearance');
  };
  const capture = async name => {
    await waitForOuroboros(() => scene('Number(getComputedStyle(document.querySelector("#load")).opacity) < .03'), 'scene intro has finished');
    const shot = await win.capturePage();
    assert.ok(!shot.isEmpty());
    const file = path.join(root, `Ouroboros_${name}_CodexV9.1.1.png`);
    await writeFile(file, shot.toPNG());
    return shot.toPNG();
  };

  if (process.env.STILLTIME_DEV_MATERIAL_QA === 'glass') {
    await click('#wb-appearance');
    await click('[data-material-choice=glass]');
    await click('#wb-appearance');
    assert.equal(await inspect('getComputedStyle(document.querySelector("#wallpaper-glass-overlay")).display'), 'block');
  }

  await mode('light');
  await settled(false);
  const day = await capture('Day');
  const initialFrame = ouroborosFrame(win).frameTreeNodeId;
  assert.equal(await scene('document.querySelectorAll("script[src]").length'), 0);
  assert.equal(await scene('typeof window.stilltimeDesktop'), 'undefined');
  assert.equal(await scene(`fetch('${APP}/api/library', { mode: 'no-cors' }).then(() => true, () => false)`), false);

  await scene('document.querySelector("#run").click()');
  await waitForOuroboros(() => scene('document.body.classList.contains("still")'), 'pause rendering with the V9 control');
  const pausedFrames = await scene('window.__frames');
  await delay(300);
  assert.equal(await scene('window.__frames'), pausedFrames);
  await mode('dark');
  await settled(true);
  assert.ok(await scene('!document.body.classList.contains("still") && window.__frames > ' + pausedFrames));
  assert.equal(ouroborosFrame(win).frameTreeNodeId, initialFrame, 'Switch mode within the same animation');
  const night = await capture('Night');
  assert.ok(!night.equals(day));
  const before = await scene('({ angle: __ouro.S.azT, zoom: __ouro.S.radT, frames: window.__frames })');
  const point = await inspect(`(() => {
    const r = document.querySelector('#wb-space').getBoundingClientRect();
    return { x: Math.round(r.x + r.width * .63), y: Math.round(r.y + r.height * .49) };
  })()`);
  const end = { x: point.x + 83, y: point.y - 27 };
  const debuggerSession = win.webContents.debugger;
  debuggerSession.attach('1.3');
  const send = (type, position, more = {}) => debuggerSession.sendCommand('Input.dispatchMouseEvent', { type, ...position, ...more });
  try {
    await send('mouseMoved', point);
    await send('mousePressed', point, { button: 'left', buttons: 1, clickCount: 1 });
    await send('mouseMoved', end, { button: 'left', buttons: 1 });
    await send('mouseReleased', end, { button: 'left', buttons: 0, clickCount: 1 });
    await send('mouseWheel', point, { deltaY: -280, deltaX: 0 });
  } finally {
    debuggerSession.detach();
  }
  await waitForOuroboros(async () => {
    const after = await scene('({ angle: __ouro.S.azT, zoom: __ouro.S.radT, frames: window.__frames })');
    return after && after.frames > before.frames && Math.abs(after.angle - before.angle) > .1 && Math.abs(after.zoom - before.zoom) > .2;
  }, 'mouse drag and wheel reach the original canvas');

  win.minimize();
  await waitForOuroboros(() => inspect('!document.querySelector("#wb-space iframe")'), 'release the 3D frame while the window is minimized');
  win.restore();
  await settled(true);
  await waitForOuroboros(() => inspect('document.querySelector("#wb-space iframe")'), 'restore the 3D frame with the current theme');

  await scene('document.querySelector("#mode").click()');
  await settled(false);
  await mode('light');
  await settled(false);
  await mode('system');
  try {
    nativeTheme.themeSource = 'dark';
    await settled(true);
    nativeTheme.themeSource = 'light';
    await settled(false);
  } finally {
    nativeTheme.themeSource = 'system';
  }
  await mode('dark');
  await settled(true);
  if (process.env.STILLTIME_LONG_RENDER_QA === '1') {
    win.minimize();
    await waitForOuroboros(() => inspect('!document.querySelector("#wb-space iframe")'), 'release the animation for idle measurement');
    app.getAppMetrics();
    await delay(600000);
    const rendererCpu = app.getAppMetrics().filter(metric => metric.type === 'Tab').reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage || 0), 0);
    assert.ok(rendererCpu < 3, `Expected minimized renderer CPU below 3%, got ${rendererCpu}`);
    console.log('LOW_POWER_VERIFY_OK', JSON.stringify({ durationMs: 600000, rendererCpu }));
    win.restore();
    await settled(true);
    win.close();
    return;
  }
  await click('.wb-nav [data-wb-nav=links]');
  await waitForOuroboros(() => inspect('!document.querySelector("#wb-space iframe")'), 'iframe released outside Home');
  await click('.wb-nav [data-wb-nav=home]');
  await settled(true);
  assert.notEqual(ouroborosFrame(win).frameTreeNodeId, initialFrame);
  await waitForOuroboros(() => inspect('window.stilltimeDesktop.loadAppearance().then(value => value.mode === "dark")'), 'appearance persisted');
  await win.loadURL(APP + '/?verify=1');
  await settled(true);
  console.log('OUROBOROS_VERIFY_OK');
  win.close();
}
