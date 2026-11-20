import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const SCENE = '32MZn9yIu3vxepgYztE6aU6VT7Wmbtrm';
const WEB = 'RGjxw8qXPLheps6j_JUB544TncwWGSTH';

export async function runDesktopCheck(win, settings) {
  const fixtureOnly = process.env.STILLTIME_DEV_WALLPAPER_FIXTURE_ONLY === '1';
  const inspect = code => win.webContents.executeJavaScript(code, true);
  const evidence = {};
  async function until(expression, time = 18000) {
    const end = Date.now() + time;
    do {
      const result = await inspect(expression);
      if (result) return result;
      await delay(150);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${expression} (kind: ${await inspect("document.querySelector('#wallpaperKind')?.textContent")})`);
  }
  async function select(query, title) {
    await inspect(`(() => {
      const get = id => document.getElementById(id);
      get('wallpaperButton').click();
      get('search').value = ${JSON.stringify(query)};
      get('search').dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('#libraryGrid button')].find(item => item.ariaLabel === ${JSON.stringify('选择 ' + title)});
      if (!button) throw new Error('Missing wallpaper: ' + ${JSON.stringify(title)});
      button.click();
      get('libraryDialog').close();
    })()`);
  }
  try {
    const response = await inspect("fetch('/api/library').then(response => response.json())");
    if (fixtureOnly) {
      assert.ok(response.stats.total >= 4, 'Expected a local image, a video, and two broken scenes.');
    } else {
      assert.ok(response.stats.total > 3000);
      assert.ok(response.items.some(item => item.id === SCENE && item.live));
      assert.ok(response.items.some(item => item.id === WEB && item.live));
    }
    const restoreItem = response.items.find(item => fixtureOnly
      ? item.title === '验收图片' && item.kind === 'image'
      : item.id === SCENE);
    assert.ok(restoreItem, 'Expected a known-good wallpaper to restore.');
    const restoredTitle = JSON.stringify(restoreItem.title);
    const restoredWallpaperReady = fixtureOnly
      ? "document.querySelector('#backgroundImage').naturalWidth > 0"
      : "document.querySelector('#wallpaperKind').textContent === '场景实时渲染'";
    evidence.libraryCount = response.stats.total;
    assert.equal(await inspect("fetch('https://example.invalid/').then(() => false, () => true)"), true);
    evidence.externalRequestBlocked = true;

    await select('验收图片', '验收图片');
    await until("document.querySelector('#currentWallpaper').textContent === '验收图片' && document.querySelector('#backgroundImage').naturalWidth > 0");
    evidence.image = true;
    await select('验收视频', '验收视频');
    await until("!document.querySelector('#backgroundVideo').hidden && document.querySelector('#backgroundVideo').currentTime > 0");
    evidence.video = true;

    if (!fixtureOnly) {
      await select('镜流', '崩坏星穹铁道-镜流');
      await until("document.querySelector('#wallpaperKind').textContent === '场景实时渲染'");
      evidence.scene = await until("JSON.parse(document.querySelector('#backgroundWeb').contentDocument?.querySelector('#sceneVerification')?.textContent || 'null')");
      assert.equal(evidence.scene.threeRevision, '187');
      assert.ok(evidence.scene.uniqueFrames > 1 && evidence.scene.sims > 0 && evidence.scene.steps > 0);

      const clorinde = response.items.find(item => item.title === '原神 克洛琳德 Genshin Impact Clorinde' && item.type === 'scene');
      assert.ok(clorinde?.live, 'The Clorinde scene should be available for live rendering.');
      await select('Clorinde', clorinde.title);
      await until(`document.querySelector('#currentWallpaper').textContent === ${JSON.stringify(clorinde.title)} && document.querySelector('#wallpaperKind').textContent === '场景实时渲染'`);
      evidence.clorindeRenderer = await until("(() => { const canvas = document.querySelector('#backgroundWeb').contentDocument?.querySelector('#sceneCanvas'); return canvas?.dataset.status === 'ready' ? { status: canvas.dataset.status, threeRevision: canvas.dataset.threeRevision } : null; })()");
      const frameRect = await inspect(`(() => {
        const bounds = document.querySelector('#backgroundWeb').getBoundingClientRect();
        return { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.round(bounds.width), height: Math.round(bounds.height) };
      })()`);
      const frameCapture = await win.capturePage(frameRect);
      const frameDataUrl = frameCapture.toDataURL();
      evidence.clorindeFrame = await inspect(`new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const sample = document.createElement('canvas');
          sample.width = 32; sample.height = 32;
          const context = sample.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0, sample.width, sample.height);
          const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
          const colors = new Set();
          const brightness = [];
          // Sample the left and right outer thirds, where the timer controls do not cover the wallpaper.
          for (let y = 5; y < 27; y++) for (const x of [1, 2, 3, 28, 29, 30]) {
            const index = (y * sample.width + x) * 4;
            colors.add(pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2]);
            brightness.push((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3);
          }
          resolve({ width: image.naturalWidth, height: image.naturalHeight, distinctColors: colors.size, brightnessRange: Math.max(...brightness) - Math.min(...brightness) });
        };
        image.src = ${JSON.stringify(frameDataUrl)};
      })`);
      assert.ok(evidence.clorindeFrame.width > 0 && evidence.clorindeFrame.height > 0);
      assert.ok(evidence.clorindeFrame.distinctColors > 4 && evidence.clorindeFrame.brightnessRange > 8, 'The rendered Clorinde frame should contain visible image detail.');
      const unicodeAssetNames = {
        model: 'models/Clorinde’s Quiet Reveal 🌙✨_134098018.json',
        material: 'materials/Clorinde’s Quiet Reveal 🌙✨_134098018.json',
        texture: 'Clorinde’s Quiet Reveal 🌙✨_134098018',
      };
      evidence.clorindeUnicodeAssets = await inspect(`Promise.all([
        fetch('/wallpapers/scene/${clorinde.id}/asset?name=' + encodeURIComponent(${JSON.stringify(unicodeAssetNames.model)})).then(response => response.status),
        fetch('/wallpapers/scene/${clorinde.id}/asset?name=' + encodeURIComponent(${JSON.stringify(unicodeAssetNames.material)})).then(response => response.status),
        fetch('/wallpapers/particle-texture?id=${clorinde.id}&name=' + encodeURIComponent(${JSON.stringify(unicodeAssetNames.texture)})).then(response => response.status),
      ])`);
      assert.deepEqual(evidence.clorindeUnicodeAssets, [200, 200, 200]);
      evidence.clorindeSceneRendered = true;

      await select('莱茵', 'Rhine Lab · 莱茵生命交互桌面 | Interactive Desktop');
      await until("document.querySelector('#wallpaperKind').textContent === '网页实时'");
      const frames = win.webContents.mainFrame.frames;
      const wall = frames.find(frame => frame.url.startsWith('https://stilltime-wallpaper.invalid/'));
      assert.ok(wall);
      evidence.web = await wall.executeJavaScript(`({
        noDesktopBridge: typeof window.stilltimeDesktop === 'undefined',
        sandboxed: typeof window.require === 'undefined',
        ready: document.readyState,
        styles: document.querySelectorAll('link[rel=stylesheet]').length
      })`);
      assert.ok(evidence.web.noDesktopBridge && evidence.web.sandboxed && evidence.web.styles);

      await select('镜流', '崩坏星穹铁道-镜流');
      await until("document.querySelector('#wallpaperKind').textContent === '场景实时渲染'");
    }
    await select('V6 缺失场景', 'V6 缺失场景');
    await inspect("document.querySelector('#inspectScene').click()");
    evidence.missingSceneDiagnostics = await until(`(() => {
      const dialog = document.querySelector('#sceneDiagnosticsDialog');
      const report = document.querySelector('#sceneDiagnosticsReport')?.value || '';
      return dialog?.open && report.includes('scene.json') && /\\b404\\b/.test(report) ? report : null;
    })()`);
    await inspect("document.querySelector('#sceneDiagnosticsDialog').close()");

    // Manual diagnostics should identify the missing model path without changing the selected scene.
    await select('V6 白屏场景', 'V6 白屏场景');
    await until("document.querySelector('#currentWallpaper').textContent === 'V6 白屏场景' && document.querySelector('#wallpaperKind').textContent === '场景实时渲染'");
    await inspect("document.querySelector('#inspectScene').click()");
    evidence.blankSceneDiagnostics = await until(`(() => {
      const dialog = document.querySelector('#sceneDiagnosticsDialog');
      const report = document.querySelector('#sceneDiagnosticsReport')?.value || '';
      return dialog?.open && report.includes('models/missing.json') && /\\b404\\b/.test(report) ? report : null;
    })()`);
    await inspect("document.querySelector('#sceneDiagnosticsDialog').close()");

    // A failed scene must not poison the next wallpaper session.
    await select(restoreItem.title, restoreItem.title);
    await until(`document.querySelector('#currentWallpaper').textContent === ${restoredTitle} && ${restoredWallpaperReady}`);
    if (!fixtureOnly) {
      const recoveredScene = await until("JSON.parse(document.querySelector('#backgroundWeb').contentDocument?.querySelector('#sceneVerification')?.textContent || 'null')");
      assert.ok(recoveredScene.uniqueFrames > 1 && recoveredScene.steps > 0);
      evidence.sceneAfterFailureAnimated = true;
    }
    evidence.wallpaperRecovered = true;

    await inspect("document.querySelector('[data-minutes=\"15\"]').click()");
    assert.match(await inspect("document.querySelector('#timer').textContent"), /^15:00$/);
    await inspect("document.querySelector('#start').click()");
    await until("document.querySelector('#startText').textContent === '暂停片刻'");
    await inspect("document.querySelector('#start').click()");
    await until("document.querySelector('#startText').textContent === '继续专注' || document.querySelector('#startText').textContent === '开始专注'");
    await inspect(`(() => {
      const get = id => document.getElementById(id);
      get('customTime').click();
      get('hoursInput').value = '0';
      get('minutesInput').value = '0';
      get('secondsInput').value = '2';
      get('applySettings').click();
      get('start').click();
    })()`);
    await until("document.querySelector('#startText').textContent === '再来一次'");
    evidence.timerCompleted = true;
    await inspect(`(() => {
      const sort = document.getElementById('wallpaperSort');
      sort.value = 'modified';
      sort.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(settings.getState().wallpaperId, restoreItem.id);
    assert.equal(settings.getState().sortBy, 'modified');
    evidence.persistence = true;

    // Reload the renderer after the saved state settles, then confirm the UI rehydrates it.
    await delay(300);
    await new Promise(resolve => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.reload();
    });
    await until(`document.querySelector('#currentWallpaper').textContent === ${restoredTitle} && document.querySelector('#wallpaperSort').value === 'modified' && ${restoredWallpaperReady}`);
    evidence.reloadRestoredState = {
      wallpaper: await inspect("document.querySelector('#currentWallpaper').textContent"),
      sortBy: await inspect("document.querySelector('#wallpaperSort').value"),
    };
  } catch (error) {
    evidence.error = String(error.stack ?? error);
  }
  await writeFile(process.env.STILLTIME_DEV_CHECK, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
