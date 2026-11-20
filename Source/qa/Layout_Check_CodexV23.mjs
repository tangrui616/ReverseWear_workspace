import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

const views = ['home', 'ideas', 'weekly', 'links', 'notes', 'experiments', 'plans', 'files', 'translation', 'life', 'clipboard', 'settings'];
const sizes = [[1920, 1080], [1320, 890], [1366, 768], [720, 620]];
const cards = [
  '.wb-panel', '.wb-home-stopwatch', '.wb-home-scene', '.wb-drop', '.wb-file-tab-rail',
  '.wb-r-create', '.wb-r-plan-panel', '.wb-r-editor', '.wb-r-experiment-card', '.wb-r-stat', '.wb-r-empty',
  '.wb-pdf-panel', '.wb-reader-notes', '.note-workspace:not(.note-workspace--reader)',
  '.web-collection__toolbar', '.web-collection__directory', '.web-collection__notes', '.web-collection__page',
  '.clipboard-workspace__head', '.clipboard-workspace__filters', '.clipboard-workspace__actions',
  '.clipboard-workspace__list', '.clipboard-workspace__detail',
  '.wb-settings__heading', '.wb-settings__startup', '.wb-settings__list-panel', '.wb-settings__editor',
  '.wb-heading', '.wb-reader-heading', '.wb-plan-tabs', '.wb-life-tabs', '.wb-filters', '.translation-card', '.translation-heading', '.translation-attribution',
].join(',');
const grids = [
  '.wb-home-layout', '.wb-home-left', '.wb-home-right', '.wb-home-timers', '.wb-idea-columns', '.wb-board-layout',
  '.wb-kanban-lanes', '.wb-r-plan-grid', '.web-collection', '.web-collection__columns',
  '.translation-layout', '.wb-life-layout', '.clipboard-workspace', '.clipboard-workspace__body',
  '.wb-settings', '.wb-settings__workspace',
].join(',');

function inspectView(name, cards, grids) {
  const canvas = document.querySelector('.wb-canvas').getBoundingClientRect();
  const toolbar = document.querySelector('.wb-top').getBoundingClientRect();
  const main = document.getElementById('wb-main');
  const section = document.getElementById('wb-' + name);
  const rect = main.getBoundingClientRect();
  const left = rect.left + main.clientLeft;
  const top = rect.top + main.clientTop;
  const right = left + main.clientWidth;
  const bottom = top + main.clientHeight;
  const visible = element => Boolean(element.getClientRects().length);
  const outerCards = [...section.querySelectorAll(cards), ...(section.matches(cards) ? [section] : [])].filter(element =>
    visible(element) && !element.parentElement.closest(cards));
  const topEdges = outerCards.map(element => element.getBoundingClientRect().top - top);
  const rightEdges = outerCards.map(element => right - element.getBoundingClientRect().right);
  const bottomEdges = outerCards.map(element => canvas.bottom - element.getBoundingClientRect().bottom);
  const gaps = [...section.querySelectorAll(grids), ...(section.matches(grids) ? [section] : [])]
    .filter(visible).map(element => {
      const { rowGap, columnGap } = getComputedStyle(element);
      return { name: element.className, values: [rowGap, columnGap] };
    });
  return {
    insets: [top - toolbar.bottom, innerWidth - right, innerHeight - bottom, left - canvas.left].map(Math.round),
    horizontalOverflow: main.scrollWidth - main.clientWidth,
    verticalOverflow: main.scrollHeight - main.clientHeight,
    topEdge: Math.round(Math.min(...topEdges)),
    rightEdge: Math.round(Math.min(...rightEdges)),
    bottomGap: Math.round(Math.min(...bottomEdges)),
    radii: outerCards.map(element => parseFloat(getComputedStyle(element).borderTopLeftRadius)),
    gaps,
  };
}

function inspectFocus() {
  const shell = document.querySelector('.app-shell');
  const timer = shell.querySelector('.timer-stage');
  const footer = shell.querySelector('.focus-footer-card');
  const a = timer.getBoundingClientRect();
  const b = footer.getBoundingClientRect();
  const top = shell.querySelector('.topbar').getBoundingClientRect();
  return {
    insets: [a.top - top.bottom, innerWidth - a.right, innerHeight - b.bottom, a.left].map(Math.round),
    gap: Math.round(b.top - a.bottom),
    radii: [timer, footer].map(element => parseFloat(getComputedStyle(element).borderTopLeftRadius)),
  };
}

export async function runLayoutCheck(win, { fixtureRoot }) {
  const exec = source => win.webContents.executeJavaScript(source);
  async function waitFor(source, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await exec(source)) return;
      await delay(75);
    }
    throw new Error('布局验收等待失败 ' + label);
  }

  const click = selector => exec('document.querySelector(' + JSON.stringify(selector) + ')?.click()');
  const workbench = "document.body.classList.contains('workbench-active')";
  async function navigate(view) {
    if (view !== 'focus' && !await exec(workbench)) {
      await click('#backToWorkbench');
      await waitFor(workbench, '返回工作台');
    }
    await click('[data-wb-nav="' + view + '"]');
    await waitFor(view === 'focus' ? '!' + workbench :
      'document.getElementById(' + JSON.stringify('wb-' + view) + ')?.hidden === false', view);
  }

  async function setAppearance(theme, material) {
    await click('[data-mode-choice="' + theme + '"]');
    await waitFor('document.documentElement.dataset.theme === ' + JSON.stringify(theme), theme);
    await click('[data-material-choice="' + material + '"]');
    await waitFor('document.documentElement.dataset.material === ' + JSON.stringify(material), material);
  }

  const evidence = [];
  const insets = [16, 16, 16, 16];
  async function checkView(label, view) {
    const measurement = '(' + inspectView.toString() + ')(' + [view, cards, grids].map(value => JSON.stringify(value)).join(',') + ')';
    await exec("document.getElementById('wb-main').scrollTop = 0");
    const start = await exec(measurement);
    assert.deepEqual(start.insets, insets, label + ' 画布四边实际距离');
    assert.ok(start.horizontalOverflow <= 1, label + ' 主画布没有横向溢出');
    assert.ok(start.radii.length > 0, label + ' 有可见卡片');
    assert.ok(start.radii.every(radius => radius === 16), label + ' 主卡片圆角为 16px ' + start.radii);
    assert.ok(start.topEdge >= -1 && start.rightEdge >= -1, label + ' 卡片未越过画布顶边和右边');
    for (const grid of start.gaps) assert.deepEqual(grid.values, ['16px', '16px'], label + ' ' + grid.name + ' 卡片间距');

    await exec("(() => { const main = document.getElementById('wb-main'); main.scrollTop = main.scrollHeight; })()");
    const end = await exec(measurement);
    assert.equal(end.bottomGap, 16, label + ' 最后一张卡片底部留白');
    return { start, bottomGap: end.bottomGap };
  }

  for (const [theme, material] of [['light', 'solid'], ['dark', 'glass']]) {
    await navigate('home');
    await setAppearance(theme, material);
    for (const [width, height] of sizes) {
      await navigate('notes');
      win.setSize(width, height);
      // Windows can subtract one DIP from a frameless window's client area at high DPI.
      await waitFor(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`, width + '×' + height);
      const viewport = await exec('({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })');
      const runExistingChecks = width === 1320 || width === 720;
      for (const view of runExistingChecks ? views : ['home']) {
        await navigate(view);
        if (view === 'home') {
          const layoutState = `(() => {
            const home = document.querySelector('#wb-home');
            const main = home.parentElement;
            const left = home.querySelector('.wb-home-left').getBoundingClientRect();
            const rightElement = home.querySelector('.wb-home-right');
            const right = rightElement.getBoundingClientRect();
            const scene = home.querySelector('.wb-home-scene').getBoundingClientRect();
            const translation = home.querySelector('.wb-home-translation').getBoundingClientRect();
            const compact = innerWidth <= 880;
            const expectedSceneWidth = right.width;
            const columns = getComputedStyle(home).gridTemplateColumns.split(' ').length;
            const matches = columns === (compact ? 1 : 2) &&
              Math.abs(scene.width - scene.height) <= 1 &&
              Math.abs(scene.width - expectedSceneWidth) <= 1 &&
              Math.abs(translation.top - scene.bottom - 16) < 1 &&
              (compact ? left.top < right.top : Math.abs(left.width - right.width) <= 1);
            return { matches, expectedSceneWidth, scene: scene.toJSON(), translation: translation.toJSON(),
              left: left.toJSON(), right: right.toJSON(), port: [main.clientWidth, main.clientHeight], columns };
          })()`;
          await waitFor(layoutState + '.matches', '首页正方形动画 ' + width + '×' + height)
            .catch(async error => { throw new Error(error.message + ' ' + JSON.stringify(await exec(layoutState))); });
          const home = await exec(`(() => {
            const main = document.getElementById('wb-main');
            const layout = document.querySelector('.wb-home-layout');
            const left = document.querySelector('.wb-home-left');
            const right = document.querySelector('.wb-home-right');
            const scene = document.querySelector('.wb-home-scene');
            const translation = document.querySelector('.wb-home-translation');
            const rect = element => {
              const box = element.getBoundingClientRect();
              return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
            };
            const output = translation.querySelector('[data-home-tr-output]');
            const originalOutput = output.value;
            const before = translation.getBoundingClientRect().height;
            output.value = '长译文换行\\n'.repeat(100);
            const longOutput = { scrolls: output.scrollHeight > output.clientHeight,
              cardHeight: translation.getBoundingClientRect().height, before };
            output.value = originalOutput;
            return {
              compact: innerWidth <= 880,
              columns: getComputedStyle(layout).gridTemplateColumns,
              layout: rect(layout), left: rect(left), right: rect(right), scene: rect(scene),
              translation: rect(translation), longOutput, scrollTop: main.scrollTop,
              scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, mainBottom: main.getBoundingClientRect().bottom,
              visibleRows: [...document.querySelectorAll('#wb-home-prompts,#wb-home-clipboard,#wb-home-todos')].map(list => {
                const marker = document.createElement('div');
                marker.dataset.layoutFixture = 'home-overflow';
                marker.style.height = '1200px';
                list.append(marker);
                const result = { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
                marker.remove();
                return result;
              }),
            };
          })()`);
          assert.ok(home.scene.width >= 1 && Math.abs(home.scene.width - home.scene.height) <= 1,
            '首页衔尾蛇容器为正方形 ' + width + '×' + height + ' ' + JSON.stringify(home.scene));
          assert.ok(home.translation.height >= 180, '首页翻译卡至少 180px 高 ' + width + '×' + height);
          assert.ok(home.longOutput.scrolls && home.longOutput.cardHeight === home.longOutput.before, '长译文在自己的文本框滚动');
          assert.equal(home.scrollTop, 0, '进入首页时未滚动');
          assert.ok(home.scene.top >= home.layout.top, '动画位于首页内容区域内');
          if (width <= 880) assert.ok(home.compact, '窄窗在 880px 断点下使用单列');
          else {
            assert.equal(home.compact, false, '常规窗口保留双栏');
            assert.ok(home.right.left > home.left.left, '宽屏首页保留双栏');
            assert.ok(Math.abs(home.left.width - home.right.width) <= 1, '正式版左右栏等宽');
            assert.equal(home.left.top, home.right.top, '双栏起点对齐');
          }
          const stableSamples = await exec(`new Promise(resolve => {
            const home = document.querySelector('#wb-home');
            const scene = home.querySelector('.wb-home-scene');
            const samples = [];
            const first = performance.now();
            function sample(now) {
              const { left, top, width, height } = scene.getBoundingClientRect();
              samples.push({ left, top, width, height, columns: getComputedStyle(home).gridTemplateColumns });
              if (samples.length >= 12 && now - first >= 1000) resolve(samples);
              else requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          })`);
          assert.ok(stableSamples.every(sample => JSON.stringify(sample) === JSON.stringify(stableSamples[0])),
            '首页固定尺寸下连续帧布局稳定 ' + JSON.stringify(stableSamples));
          const resizedHeight = height === 620 ? height + 40 : height - 40;
          win.setSize(width, resizedHeight);
          await waitFor(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${resizedHeight}) <= 1`, '固定宽度调整高度');
          const heightChanged = await exec(`(() => {
            const home = document.querySelector('#wb-home');
            const scene = home.querySelector('.wb-home-scene').getBoundingClientRect();
            return { left: scene.left, width: scene.width, height: scene.height };
          })()`);
          assert.equal(heightChanged.width, stableSamples[0].width, '只改高度不改变动画宽度');
          assert.equal(heightChanged.left, stableSamples[0].left, '只改高度不改变动画横向位置');
          assert.ok(Math.abs(heightChanged.width - heightChanged.height) <= 1, '改窗高后动画仍为正方形');
          await win.setSize(width, height);
          await waitFor(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`, '恢复首页验收尺寸');
          assert.ok(home.visibleRows.every(list => list.clientHeight > 0 && list.scrollHeight > list.clientHeight),
            '提示词、剪贴和待办列表容器可独立滚动');
          // The original narrow layout puts the left column before the animation.
          // Chromium may suspend the iframe's frames until it is scrolled into view.
          if (home.scene.top >= home.mainBottom) {
            await exec("document.querySelector('.wb-home-scene').scrollIntoView({ block: 'start' })");
          }
          await waitForOuroboros(() => readOuroboros(win,
            'window.__frames > 5 && Number(getComputedStyle(document.querySelector("#load")).opacity) < .03'), '首页正方形动画完成加载');
          const hud = await readOuroboros(win, `(() => {
            const elements = [...document.querySelectorAll('#title,#ctrl,#quote,#hint')].filter(el => getComputedStyle(el).display !== 'none');
            const boxes = elements.map(el => el.getBoundingClientRect());
            return { width: innerWidth, height: innerHeight,
              fits: boxes.every(box => box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1),
              overlaps: boxes.some((box, i) => boxes.slice(i + 1).some(other => box.right > other.left && other.right > box.left && box.bottom > other.top && other.bottom > box.top)) };
          })()`);
          assert.ok(hud && hud.fits && !hud.overlaps && Math.abs(hud.width - hud.height) <= 1, JSON.stringify(hud));
          evidence.push({ theme, material, width, height, view: 'home-square', home, hud, stableFrameCount: stableSamples.length });
          const suffix = material === 'solid' ? '' : '-glass';
          await writeFile(path.join(fixtureRoot, `home-square-${width}x${height}${suffix}.png`),
            (await win.webContents.capturePage()).toPNG());
        }
        const measure = await checkView(view + ' ' + width + ' ' + material, view);
        evidence.push({ theme, material, width, height, viewport, view, ...measure });
        if (width === 1320 && ['links', 'notes', 'clipboard'].includes(view)) {
          assert.equal(measure.start.verticalOverflow, 0, view + ' 满高卡片无外部溢出');
        }
        if ((material === 'solid' && width === 720 && view === 'settings') ||
            (material === 'glass' && width === 1320 && view === 'home')) {
          await delay(850);
          await writeFile(path.join(fixtureRoot, 'layout-' + view + '-' + width + '-' + material + '.png'),
            (await win.webContents.capturePage()).toPNG());
        }
      }

      if (!runExistingChecks) continue;
      if (material === 'solid') {
        await navigate('ideas');
        for (const tab of ['inbox', 'cards', 'kanban', 'board']) {
          await click('[data-idea-tab="' + tab + '"]');
          await waitFor('document.querySelector(\'[data-idea-pane="' + tab + '"]\')?.hidden === false', 'ideas/' + tab);
          evidence.push({ theme, material, width, height, view: 'ideas', tab, ...await checkView('ideas/' + tab, 'ideas') });
        }
        await navigate('plans');
        await click('.wb-plan-tabs button:last-child');
        await waitFor("!document.querySelector('.wb-r-plan-grid').hidden", '计划与目标');
        evidence.push({ theme, material, width, height, view: 'plans', tab: '计划与目标', ...await checkView('计划与目标', 'plans') });
      }

      await navigate('focus');
      const focus = await exec('(' + inspectFocus.toString() + ')()');
      assert.deepEqual(focus.insets, insets, '专注画布四边实际距离 ' + width + ' ' + material);
      assert.equal(focus.gap, 16, '专注两卡之间的距离');
      assert.deepEqual(focus.radii, [16, 16], '专注两块卡片圆角');
      evidence.push({ theme, material, width, height, view: 'focus', ...focus });
      if (width === 720 && material === 'solid') {
        await delay(500);
        await writeFile(path.join(fixtureRoot, 'layout-focus-720-solid.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
  }

  await writeFile(path.join(fixtureRoot, 'layout-v23.json'), JSON.stringify(evidence, null, 2));
  return { views: views.length + 1, sizes, surfaces: ['light/solid', 'dark/glass'], measurements: evidence.length };
}
