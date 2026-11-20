import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, nativeTheme } from 'electron';
import { ouroborosFrame, readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

export async function runAppearanceCheck(win, settings) {
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root, 'Use an isolated data root');
  const settingsPath = path.join(root, 'Settings', 'Stilltime', 'appearance.json');
  const inspect = source => win.webContents.executeJavaScript(source, true);
  const click = selector => inspect('document.querySelector(' + JSON.stringify(selector) + ').click()');
  async function until(expression) {
    for (let attempts = 0; attempts < 120; attempts++) {
      if (await inspect(expression)) return;
      await delay(70);
    }
    throw new Error('Timed out: ' + expression);
  }
  async function capture(name) {
    await delay(360);
    const screenshot = await win.capturePage();
    assert.ok(!screenshot.isEmpty());
    await writeFile(path.join(root, 'Stilltime_' + name + '_CodexV9.png'), screenshot.toPNG());
  }
  const theme = 'document.documentElement.dataset.theme';
  const palette = 'document.documentElement.dataset.palette';
  const material = 'document.documentElement.dataset.material';
  const blur = 'document.querySelector("#wb-glass-blur").value';
  const cardFilter = 'getComputedStyle(document.querySelector(".wb-home-card")).backdropFilter';
  const waitForRendering = frames => waitForOuroboros(
    () => readOuroboros(win, 'window.__frames > ' + frames),
    `Three.js frame count above ${frames}`,
  );
  const showPanel = async () => {
    await click('#wb-appearance');
    await until('!document.querySelector("#wb-appearance-panel").hidden');
  };
  const nav = view => click('.wb-nav [data-wb-nav=' + view + ']');
  const choose = (key, value) => click('[data-' + key + '-choice=' + value + ']');
  const loaded = 'document.querySelector(".wb-nav [data-wb-nav=home]").getAttribute("aria-current") === "page"';
  await until(loaded);
  assert.equal(await inspect(material), 'solid', '新隔离配置默认使用经典实体材质');
  assert.equal(await inspect('localStorage.getItem("ui_material")'), null, '材质配置使用独立的 Chromium 本地存储');
  await until(`(() => {
    const rects = [...document.querySelectorAll('.mac-window-controls button')].map(button => button.getBoundingClientRect());
    return rects.length === 3 && rects.every(rect =>
      Math.abs(rect.width - 21.6) <= 1.2 && Math.abs(rect.height - 21.6) <= 1.2) &&
      rects.slice(1).every((rect, index) => rect.left >= rects[index].right);
  })()`, '工作台标题栏三个窗口按钮均约为 21.6 CSS px');
  assert.equal(await inspect('document.querySelector(".wb-brand strong").textContent'), '反穿衣');
  assert.ok(await inspect('document.title.includes("反穿衣")'));
  assert.ok(await inspect('document.querySelector(".wb-home-left") && document.querySelector("#wb-timer-status")'));
  await waitForRendering(2);
  await showPanel();
  assert.ok(await inspect('document.querySelector("#wb-glass-blur-control").hidden'));
  assert.ok(await inspect(`(() => {
    const button = document.querySelector('[data-mode-choice=dark]');
    const { x, y, width, height } = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  })()`));
  await choose('mode', 'light');
  await choose('palette', 'mist');
  await until(theme + ' === "light" && ' + palette + ' === "mist"');
  assert.ok(await inspect('document.querySelector("#wb-appearance [data-wb-icon] svg path") !== null'));
  await click('#wb-appearance');
  await capture('Material_Solid_Home');
  await nav('links');
  await until('!document.querySelector("#wb-links").hidden');
  await capture('Material_Solid_Links');
  await nav('home');
  await until(loaded);
  await waitForRendering(5);
  await showPanel();
  assert.equal(await inspect('document.querySelectorAll("[data-material-choice]").length'), 2, '材质分区提供两档选择');
  await choose('material', 'glass');
  await until(material + ' === "glass" && document.querySelector("[data-material-choice=glass]").getAttribute("aria-pressed") === "true"');
  assert.equal(await inspect('localStorage.getItem("ui_material")'), 'glass', '选择毛玻璃后立即保存');
  assert.equal(await inspect(blur), '24');
  assert.ok(await inspect('!document.querySelector("#wb-glass-blur-control").hidden'));
  assert.equal(await inspect('getComputedStyle(document.querySelector("#wb-appearance-panel")).backgroundColor'),
    'rgba(247, 249, 252, 0.97)', '悬浮设置保持可读');
  await until(`(() => {
    const overlay = document.querySelector('#wallpaper-glass-overlay');
    const root = getComputedStyle(document.documentElement);
    const card = document.querySelector('.wb-home-card');
    const panel = getComputedStyle(card);
    const parseColor = value => (value.match(/[\\d.]+/g) || []).map(Number);
    const tokenColor = parseColor(root.getPropertyValue('--glass-bg-card'));
    const renderedColor = parseColor(panel.backgroundColor);
    const expected = [255, 255, 255, 0.47];
    return overlay && tokenColor.length === 4 && renderedColor.length === 4 &&
      tokenColor.every((value, index) => Math.abs(value - expected[index]) < 0.01) &&
      renderedColor.every((value, index) => Math.abs(value - expected[index]) < 0.01) &&
      panel.backdropFilter === 'blur(24px)' &&
      getComputedStyle(overlay).backdropFilter === 'none' &&
      getComputedStyle(document.querySelector('#workbench')).backgroundColor === 'rgba(0, 0, 0, 0)';
  })()`);
  await inspect('document.querySelector("#wb-glass-blur").focus()');
  for (const [keyCode, radius] of [['Home', '0'], ['End', '48'], ['Left', '47']]) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await until(`${blur} === '${radius}' && ${cardFilter} === 'blur(${radius}px)' && localStorage.getItem('ui_material_blur') === '${radius}'`);
    assert.equal(await inspect('document.querySelector("#wb-glass-blur-value").value'), `${radius} px`);
  }
  await click('#wb-appearance');
  await capture('Material_Glass_Light_Home');
  await nav('links');
  await until('!document.querySelector("#wb-links").hidden');
  await capture('Material_Glass_Light_Links');
  await nav('home');
  await until(loaded);
  await waitForRendering(5);
  await showPanel();
  for (const value of ['ocean', 'sage', 'sand', 'plum']) {
    await choose('palette', value);
    await until(palette + ' === ' + JSON.stringify(value));
  }
  const ouroborosFrameId = ouroborosFrame(win).frameTreeNodeId;
  for (let index = 0; index < 50; index++) {
    const mode = index % 2 ? 'dark' : 'light';
    await choose('mode', mode);
    await until(theme + ' === ' + JSON.stringify(mode));
  }
  await choose('mode', 'dark');
  await until(theme + ' === "dark"');
  await until(`(() => {
    const parseColor = value => (value.match(/[\\d.]+/g) || []).map(Number);
    const tokenColor = parseColor(getComputedStyle(document.documentElement).getPropertyValue('--glass-bg-card'));
    const renderedColor = parseColor(getComputedStyle(document.querySelector('.wb-home-card')).backgroundColor);
    const expected = [38, 41, 45, 0.36];
    return tokenColor.length === 4 && renderedColor.length === 4 &&
      tokenColor.every((value, index) => Math.abs(value - expected[index]) < 0.01) &&
      renderedColor.every((value, index) => Math.abs(value - expected[index]) < 0.01) &&
      getComputedStyle(document.querySelector('.wb-home-card')).backdropFilter === 'blur(47px)';
  })()`);
  await click('#wb-appearance');
  await capture('Material_Glass_Dark_Home');
  assert.equal(ouroborosFrame(win).frameTreeNodeId, ouroborosFrameId, '主题色与材质切换不重建衔尾蛇 iframe');
  await nav('links');
  await until('!document.querySelector("#wb-links").hidden');
  await capture('Material_Glass_Dark_Links');
  await nav('home');
  await until(loaded);
  await waitForRendering(5);
  await showPanel();
  await until('document.querySelector(".wb-risk-dialog")');
  await click('[data-risk-open=settings]');
  await until('document.querySelector(".wb-risk-dialog").open');
  await until('document.querySelector(".wb-risk-dialog input[type=time]")');
  assert.ok(await inspect('document.querySelector(".wb-risk-dialog input[type=time]")'));
  await click('.wb-risk-dialog header button');
  await inspect('document.querySelector("#wb-appearance").focus()');
  await capture('Appearance');
  await inspect('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))');
  await until('document.querySelector("#wb-appearance-panel").hidden && document.activeElement.id === "wb-appearance"');
  await inspect('document.activeElement.blur()');
  await capture('Dark');
  assert.ok(await readOuroboros(win, 'window.__frames > 5'));
  await nav('links');
  await until('!document.querySelector("#wb-links").hidden && !document.querySelector("#wb-space iframe")');
  await capture('Dark_Links');
  await nav('experiments');
  await until('!document.querySelector("#wb-experiments").hidden');
  await capture('Dark_Experiments');
  await nav('plans');
  await until('!document.querySelector("#wb-plans").hidden');
  await capture('Dark_Plans');
  await click('.wb-focus-nav');
  await click('#settingsButton');
  await until('document.querySelector("#settingsDialog").open');
  await capture('Dark_Timer_Settings');
  await click('[data-close=settingsDialog]');
  await click('#backToWorkbench');
  await nav('home');
  await showPanel();
  await choose('mode', 'system');
  await until('document.querySelector("[data-mode-choice=system]").getAttribute("aria-pressed") === "true"');
  try {
    nativeTheme.themeSource = 'light';
    await until(theme + ' === "light"');
    nativeTheme.themeSource = 'dark';
    await until(theme + ' === "dark"');
  } finally {
    nativeTheme.themeSource = 'system';
  }
  await choose('mode', 'dark');
  await until('window.stilltimeDesktop.loadAppearance().then(value => value.mode === "dark" && value.palette === "plum")');
  assert.deepEqual(settings.getAppearance(), { mode: 'dark', palette: 'plum' });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { mode: 'dark', palette: 'plum' });
  await win.loadURL('https://stilltime-app.invalid/?verify=1');
  await until(loaded + ' && ' + theme + ' === "dark" && ' + palette + ' === "plum" && ' + material + ' === "glass"');
  assert.equal(await inspect('localStorage.getItem("ui_material")'), 'glass', '刷新后材质选择仍然保留');
  assert.equal(await inspect(blur), '47', '刷新后模糊强度仍然保留');
  win.setSize(760, 670);
  await until('window.innerWidth < 800');
  await showPanel();
  assert.ok(await inspect('document.querySelector("#wb-appearance-panel").getBoundingClientRect().left >= 0'));
  await capture('Compact');
  await inspect('document.querySelector("[data-material-choice=solid]").click()');
  await until(material + ' === "solid"');
  assert.ok(await inspect('document.querySelector("#wb-glass-blur-control").hidden'));
  assert.ok(await inspect(`getComputedStyle(document.querySelector('.wb-home-card')).backdropFilter === 'none'`), '经典实体应关闭卡片模糊');
  await click('#wb-appearance');
  await capture('Material_Solid_Compact');
  await showPanel();
  await inspect('document.querySelector("[data-material-choice=glass]").click()');
  await until(material + ' === "glass"');
  assert.equal(await inspect(blur), '47', '切回毛玻璃恢复之前的强度');
  await click('#wb-appearance');
  await capture('Material_Glass_Compact');

  const originalZoom = win.webContents.getZoomFactor();
  try {
    win.webContents.setZoomFactor(1.5);
    await until('window.devicePixelRatio > 0', '读取 150% 缩放时的设备像素比');
    await click('#wb-appearance');
    await until('!document.querySelector("#wb-appearance-panel").hidden', '150% 缩放时打开外观浮层');
    assert.ok(await inspect(`(() => {
      const panel = document.querySelector('#wb-appearance-panel');
      const button = panel.querySelector('[data-material-choice="glass"]');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth &&
        rect.top >= 0 && rect.bottom <= innerHeight && button.contains(hit);
    })()`), '150% 缩放下原生毛玻璃选项可见且可点');
    assert.ok(await inspect(`(() => {
      const slider = document.querySelector('#wb-glass-blur');
      slider.scrollIntoView({ block: 'nearest' });
      const rect = slider.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === slider;
    })()`), '150% 缩放下模糊强度滑块可通过面板滚动访问');
    console.log('WINDOW_CONTROL_LAYOUT', JSON.stringify(await inspect(`({
      zoom: window.visualViewport?.scale ?? 1,
      devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      material: document.documentElement.dataset.material
    })`)));
    assert.ok(await inspect(`(() => {
      const buttons = [...document.querySelectorAll('.mac-window-controls button')];
      if (buttons.length !== 3) return false;
      const rects = buttons.map(button => button.getBoundingClientRect());
      const sizesMatch = rects.every(rect => Math.abs(rect.width - 21.6) <= 1.2 && Math.abs(rect.height - 21.6) <= 1.2);
      const separated = rects.slice(1).every((rect, index) => rect.left >= rects[index].right);
      return sizesMatch && separated;
    })()`), '150% 缩放下毛玻璃模式的三个标题栏按钮维持尺寸且互不重叠');
    await click('#wb-appearance');
    await capture('Material_Glass_150_Percent');
    await inspect('document.querySelector("[data-material-choice=solid]").click()');
    await until(material + ' === "solid"');
    assert.ok(await inspect(`(() => {
      const rects = [...document.querySelectorAll('.mac-window-controls button')].map(button => button.getBoundingClientRect());
      return rects.length === 3 && rects.every(rect => Math.abs(rect.width - 21.6) <= 1.2 && Math.abs(rect.height - 21.6) <= 1.2) &&
        rects.slice(1).every((rect, index) => rect.left >= rects[index].right);
    })()`), '150% 缩放下经典实体模式的三个标题栏按钮维持尺寸且互不重叠');
  } finally {
    win.webContents.setZoomFactor(originalZoom);
  }

  const invalidMaterial = await inspect(`(() => {
    localStorage.setItem('ui_material', 'unknown');
    localStorage.setItem('ui_material_blur', '500');
    return true;
  })()`);
  assert.equal(invalidMaterial, true);
  await win.loadURL('https://stilltime-app.invalid/?verify=1');
  await until(loaded + ' && ' + material + ' === "solid"');
  assert.equal(await inspect('localStorage.getItem("ui_material")'), 'unknown', '无效值采用实体回退，不覆写原始存储值');
  assert.equal(await inspect(blur), '24', '无效的模糊强度回退到 24 px');
  await inspect('localStorage.removeItem("ui_material")');
  await showPanel();
  await choose('material', 'glass');
  await until(material + ' === "glass"');
  await click('#wb-appearance');
  await click('.wb-focus-nav');
  await until('!document.body.classList.contains("workbench-active")');
  await until(`(() => {
    const rects = [...document.querySelectorAll('.mac-window-controls button')].map(button => button.getBoundingClientRect());
    return rects.length === 3 && rects.every(rect =>
      Math.abs(rect.width - 21.6) <= 1.2 && Math.abs(rect.height - 21.6) <= 1.2) &&
      rects.slice(1).every((rect, index) => rect.left >= rects[index].right);
  })()`, '专注页三个窗口按钮均约为 21.6 CSS px');
  await capture('Focus_Window_Controls');
  if (process.env.STILLTIME_LONG_RENDER_QA === '1') {
    await win.loadURL('https://stilltime-app.invalid/?verify=1');
    await until(loaded);
    await waitForRendering(2);
    const beforeMemory = await win.webContents.getProcessMemoryInfo();
    win.minimize();
    await waitForOuroboros(() => inspect('!document.querySelector("#wb-space iframe")'), 'dispose animation before low power measurement');
    await delay(600000);
    const rendererCpu = app.getAppMetrics().filter(metric => ['Tab', 'Renderer'].includes(metric.type)).reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage || 0), 0);
    const afterMemory = await win.webContents.getProcessMemoryInfo();
    assert.ok(rendererCpu < 3, `Expected idle renderer CPU below 3%, got ${rendererCpu}`);
    console.log('LOW_POWER_VERIFY_OK', JSON.stringify({ durationMs: 600000, rendererCpu, beforeMemory, afterMemory }));
    win.restore();
    await waitForRendering(2);
  }
  console.log('APPEARANCE_VERIFY_OK');
  win.close();
}
