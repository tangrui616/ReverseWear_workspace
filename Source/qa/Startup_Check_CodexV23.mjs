import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ouroborosFrame, readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

export async function runStartupCheck(win, { fixtureRoot, documentsDirectory }) {
  const exec = script => win.webContents.executeJavaScript(script);
  const selector = value => `document.querySelector(${JSON.stringify(value)})`;
  const click = value => exec(`(() => { const node=${selector(value)}; if (!node) throw new Error('Missing ${value}'); node.click(); return true; })()`);

  async function waitFor(expression, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await exec(expression)) return;
      await delay(80);
    }
    throw new Error(`开屏验收等待失败：${label}`);
  }

  async function press(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }

  async function clickAt(value) {
    const rect = await exec(`(() => { const r=${selector(value)}?.getBoundingClientRect(); return r && {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    assert.ok(rect, `开屏控件存在 ${value}`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) });
  }

  async function screenshot(name) {
    await writeFile(path.join(fixtureRoot, name), (await win.webContents.capturePage()).toPNG());
  }

  async function waitForSplash() {
    await waitFor("document.documentElement.dataset.startupActive && document.querySelector('#st-splash canvas#c')", '冷启动开屏');
  }

  async function verifySplashSurface() {
    const surface = await exec(`(() => {
      const root=document.querySelector('#st-splash');
      const canvas=root?.querySelector('canvas#c');
      const status=root?.querySelector('#hud .st-status');
      const subtitle=root?.querySelector('#hud .st-sub');
      const mode=root?.querySelector('#mode');
      const rect=root?.getBoundingClientRect();
      return {root:!!root,canvas:!!canvas,hud:!!status&&!!subtitle,mode:!!mode,
        phase:root?.dataset.phase,night:root?.classList.contains('night'),
        homeSuspended: !document.querySelector('#wb-space iframe') && document.getElementById('workbench').inert,
        size:rect&&[Math.round(rect.width),Math.round(rect.height)],
        text:root?.innerText||'',resources:performance.getEntriesByType('resource').map(item=>item.name).filter(name=>name.includes('/startup/voice/'))};
    })()`);
    assert.ok(surface.root && surface.canvas && surface.hud && surface.mode, '开屏画布、字幕和日夜开关均已挂载');
    assert.deepEqual(surface.size, await exec('[innerWidth, innerHeight]'), '开屏覆盖整个内容区');
    assert.match(surface.text, /STILLTIME|唤醒许可|IDENTITY|MOUNTING|LOADING|核验通过/i, '开屏显示状态文字');
    return surface;
  }

  await waitForSplash();
  const playbackTrace = await exec(`(() => {
    const trace = document.createElement('template');
    trace.id = 'qa-startup-voice-trace';
    trace.dataset.lines = '[]';
    document.body.append(trace);
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...argumentsList) {
      const filename = this.src.split('/').at(-1);
      const playback = original.apply(this, argumentsList);
      if (this.src.includes('/startup/voice/') && /^line-[0-9]+[.](mp3|wav)$/.test(filename)) {
        playback?.then(() => {
          const lines = JSON.parse(trace.dataset.lines);
          lines.push(filename);
          trace.dataset.lines = JSON.stringify(lines);
        }, () => {});
      }
      return playback;
    };
    return true;
  })()`);
  assert.ok(playbackTrace);
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'wake'", '唤醒许可阶段');
  const coldSurface = await verifySplashSurface();
  assert.ok(coldSurface.homeSuspended, '播放开屏时暂停首页 WebGL 并锁定输入');
  const mediaResources = () => exec("performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('/startup/voice/'))");
  await waitFor("performance.getEntriesByType('resource').some(item => item.name.endsWith('/startup/voice/line-1.mp3'))", '唤醒语音素材已请求');
  const mediaProbe = await exec(`new Promise(resolve => {
    const audio = new Audio(new URL('./startup/voice/line-1.mp3?qa-decoder', location.href));
    audio.preload = 'auto';
    audio.addEventListener('canplay', async () => {
      try {
        audio.muted = true;
        await audio.play();
        setTimeout(() => {
          resolve({ ok: true, readyState: audio.readyState, duration: audio.duration, played: audio.currentTime > 0 });
          audio.pause();
        }, 150);
      } catch (error) { resolve({ ok: false, error: error.message }); }
    }, { once: true });
    audio.addEventListener('error', () => resolve({ ok: false, error: audio.error?.code }), { once: true });
    audio.load();
    setTimeout(() => resolve({ ok: audio.readyState >= 2, readyState: audio.readyState }), 8000);
  })`);
  assert.ok(mediaProbe.ok && mediaProbe.played, '开屏 MP3 在 Chromium 中可解码并实际推进播放时间');
  assert.ok(Math.abs(mediaProbe.duration * 1000 - 1960) <= 100, '唤醒语音是压缩包的 line-1 音轨');
  const dataProbe = await exec('window.stilltimeDesktop.startupProbe()');
  assert.ok(dataProbe.ok && dataProbe.dataRoot.toLowerCase() === fixtureRoot.toLowerCase());
  await screenshot('startup-cold-wake.png');

  if (!coldSurface.night) await click('#st-splash #mode');
  await waitFor("document.querySelector('#st-splash')?.classList.contains('night')", '夜金主题切换');
  await delay(1700);
  await screenshot('startup-night-wake.png');
  await press('N');
  await waitFor("!document.querySelector('#st-splash')?.classList.contains('night')", 'N 键切回晨光');
  await clickAt('#st-splash canvas#c');
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'fly'", '点击画面开始双龙入场');
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'confirm'", '入场完成并显示身份确认', 25000);
  await delay(850);
  await screenshot('startup-day-formed.png');
  await press('Space');
  await waitFor("!document.querySelector('#st-splash') && !document.documentElement.dataset.startupActive", '开屏揭幕完成', 20000);
  const playedLines = await exec("JSON.parse(document.getElementById('qa-startup-voice-trace').dataset.lines)");
  assert.deepEqual(playedLines, ['line-1.mp3', 'line-2.mp3', 'line-3.mp3', 'line-4.mp3', 'line-5.mp3', 'line-6.wav']);
  await waitFor("document.querySelector('#wb-home') && !document.querySelector('#wb-home').hidden", '工作台恢复交互');
  await screenshot('startup-home-after-reveal.png');

  assert.equal(await exec("typeof window.stilltimeDesktop.loadState"), 'function', '桌面桥接存在');
  await click('[data-wb-nav="settings"]');
  await waitFor("document.querySelector('#wb-settings') && !document.querySelector('#wb-settings').hidden", '开屏设置页');
  const identityState = { identity: '开屏验收', identityId: 'RW-QA-23', accessLevel: '验证 · 3' };
  await exec(`(() => {
    for (const [key,value] of Object.entries(${JSON.stringify(identityState)})) {
      const field = document.querySelector('[data-identity="' + key + '"]');
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('[data-identity-save]').click();
  })()`);
  await waitFor("document.querySelector('[data-identity-status]').textContent === '已保存'", '身份界面保存');
  const loadedIdentity = await exec('window.stilltimeDesktop.loadState().then(state => state.startupIdentity)');
  assert.deepEqual(loadedIdentity, identityState, '开屏身份通过工作台状态保存并重新读取');
  await click('[data-startup-test-voice]');
  await waitFor("performance.getEntriesByType('resource').some(item => item.name.endsWith('/startup/voice/line-6.wav'))", '设置页语音试听加载裁剪后的欢迎语');
  await screenshot('startup-settings.png');
  await click('[data-startup-preview]');
  await waitForSplash();
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'wake'", '预览进入唤醒许可');
  await screenshot('startup-preview-wake.png');
  await press('Enter');
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'fly'", 'Enter 推进预览');
  await press('Escape');
  await waitFor("!document.querySelector('#st-splash') && !document.documentElement.dataset.startupActive", 'Esc 跳过预览');
  await waitFor("document.querySelector('#wb-settings') && !document.querySelector('#wb-settings').hidden", '跳过后返回工作台');

  const runPreview = () => click('[data-startup-preview]');
  const waitForSkipButton = () => waitFor(`(() => {
    const button = document.querySelector('#st-skip');
    if (!button || button.hidden || button.disabled) return false;
    const { left, top, width, height } = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
  })()`, '跳过按钮可见且可点击');
  const waitForPreviewClosed = () => waitFor(
    "!document.querySelector('#st-splash') && !document.getElementById('workbench').inert",
    '跳过按钮结束开屏并释放工作台',
  );
  await runPreview();
  await waitForSkipButton();
  await clickAt('#st-skip');
  await waitForPreviewClosed();

  await runPreview();
  await waitForSkipButton();
  assert.equal(await exec(`(() => {
    const button = document.getElementById('st-skip');
    button.focus();
    return document.activeElement === button;
  })()`), true, '跳过按钮支持键盘焦点');
  await press('Enter');
  await waitForPreviewClosed();

  await click('[data-startup="allowSkip"]');
  await runPreview();
  await waitFor("document.querySelector('#st-splash')?.dataset.phase === 'wake'", '关闭跳过设置后仍可启动预览');
  assert.equal(await exec("document.getElementById('st-skip').hidden"), true, '关闭跳过设置会隐藏按钮');
  await press('Escape');
  assert.equal(await exec("document.querySelector('#st-splash')?.dataset.phase"), 'wake', '关闭跳过设置同步约束 Esc');
  await exec('window.dispatchEvent(new Event("pagehide"))');
  await waitForPreviewClosed();
  await click('[data-startup="allowSkip"]');

  await click('[data-wb-nav="home"]');
  const firstFrame = await waitForOuroboros(() => {
    const frame = readOuroboros(win, 'window.__frames');
    return frame.then(value => Number.isInteger(value) && value > 4 ? value : false);
  }, '揭幕后首页动画启动');
  const firstFrameId = ouroborosFrame(win)?.frameTreeNodeId;
  await click('[data-wb-nav="plans"]');
  await waitFor("!document.querySelector('#wb-space iframe')", '离开首页后释放衔尾蛇画布');
  await click('[data-wb-nav="home"]');
  const resumedFrame = await waitForOuroboros(() => {
    const frame = readOuroboros(win, 'window.__frames');
    return frame.then(value => Number.isInteger(value) && value > 4 ? value : false);
  }, '返回首页后衔尾蛇动画恢复');
  const resumedFrameId = ouroborosFrame(win)?.frameTreeNodeId;
  assert.ok(firstFrameId && resumedFrameId && firstFrameId !== resumedFrameId, '首页动画离开时释放并在返回后重新创建');

  const decoderAssets = (await mediaResources()).length;
  await click('[data-wb-nav="settings"]');
  await exec(`(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (this.id === 'c' && kind === 'webgl2') {
        HTMLCanvasElement.prototype.getContext = getContext;
        document.documentElement.dataset.qaWebglDenied = 'true';
        return null;
      }
      return getContext.call(this, kind, ...args);
    };
    document.querySelector('[data-startup-preview]').click();
  })()`);
  await waitFor("document.documentElement.dataset.qaWebglDenied && !document.querySelector('#st-splash') && !document.getElementById('workbench').inert", '无 WebGL2 时直接释放开屏');
  await click('[data-wb-nav="home"]');
  await waitFor("!document.querySelector('#wb-home').hidden && document.querySelector('#wb-home-calendar').textContent.includes('星期')", '无 WebGL2 时首页交互可用');
  return {
    coldStart: true,
    themes: ['day', 'night'],
    clickAndKeys: ['canvas-click', 'Enter', 'N', 'Space', 'Escape', 'skip-button-click', 'skip-button-Enter'],
    skipSettingVerified: true,
    voiceAssetRequests: decoderAssets,
    playedLines,
    mediaProbe,
    identityPersisted: true,
    firstFrame,
    resumedFrame,
    animationPausedAndResumed: true,
    mirrorProbe: dataProbe.ok,
    noWebGLFallback: true,
    documentsDirectory,
  };
}
