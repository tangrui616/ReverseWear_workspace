import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeImage } from 'electron';

const BUILTINS = [
  { id: 'builtin-mountain', title: '远山 · 静谧时分' },
  { id: 'builtin-night', title: '远山 · 深夜微光' },
  { id: 'builtin-dawn', title: '远山 · 晨雾初醒' },
];
const AUDIO_TITLE = 'V15 音频验收网页';
const VIDEO_TITLE = 'V22 连续播放视频验收';
const IMAGE_TITLE = 'V22-Glass-Pattern';

export async function prepareFocusFixture(fixtureRoot) {
  const wallpaperRoot = path.resolve(fixtureRoot, 'AudioFixtures');
  const projectRoot = path.join(wallpaperRoot, 'V15_Audio_Test');
  const videoRoot = path.join(wallpaperRoot, 'V22_Video_Test');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(videoRoot, { recursive: true });
  const width = 1200;
  const height = 800;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const stripe = Math.sin((x + y / 2) / 6) > 0 ? 50 : 0;
      const warm = x > 670 + 125 * Math.sin(y / 185);
      pixels[index] = (warm ? 41 : 109) + stripe;
      pixels[index + 1] = (warm ? 95 : 134) + stripe;
      pixels[index + 2] = (warm ? 172 : 33) + stripe;
      pixels[index + 3] = 255;
    }
  }
  await writeFile(path.join(wallpaperRoot, IMAGE_TITLE + '.png'), nativeImage.createFromBitmap(pixels, { width, height }).toPNG());
  await writeFile(path.join(videoRoot, 'project.json'), JSON.stringify({
    id: 'V22_Video_Test', type: 'video', file: 'fixture.mp4', preview: 'preview.svg', title: VIDEO_TITLE,
  }, null, 2) + '\n');
  await writeFile(path.join(videoRoot, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#694f7c"/><text x="50%" y="52%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">V22 Video Fixture</text></svg>');
  await copyFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'fixtures', 'wallpaper', '普通媒体', '子目录', '验收视频.mp4'),
    path.join(videoRoot, 'fixture.mp4'),
  );
  await writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
    type: 'web', file: 'index.html', preview: 'preview.svg', title: AUDIO_TITLE,
  }, null, 2) + '\n');
  await writeFile(path.join(projectRoot, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#36536b"/><text x="50%" y="52%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">V15 Audio Fixture</text></svg>');
  await writeFile(path.join(projectRoot, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>${AUDIO_TITLE}</title></head>
<body><audio id="fixture-audio" src="tone.wav" loop></audio>
<script>
const audio = document.querySelector('#fixture-audio');
audio.volume = 0.35;
setTimeout(() => audio.play().catch(() => {}), 0);
</script></body></html>`);

  const sampleRate = 44100;
  const sampleCount = sampleRate * 2;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.min(1, index / 400, (sampleCount - index) / 400);
    const sample = Math.sin(2 * Math.PI * 440 * index / sampleRate) * envelope * 0.2;
    wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  await writeFile(path.join(projectRoot, 'tone.wav'), wav);

  const sceneRoot = path.join(wallpaperRoot, 'V22_Scene_Test');
  await mkdir(sceneRoot, { recursive: true });
  await writeFile(path.join(sceneRoot, 'project.json'), JSON.stringify({
    type: 'scene', file: 'scene.json', preview: 'preview.svg', title: 'V22 Scene Fixture',
  }));
  await writeFile(path.join(sceneRoot, 'scene.json'), JSON.stringify({
    general: { clearcolor: '0.45 0.29 0.16', orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [{
      id: 1, name: 'Glass test pattern', text: 'V22 Wallpaper Scene',
      pointsize: 96, color: '0.2 0.8 0.55', origin: '960 540 0',
      scale: '1 1 1', alignment: 'center',
    }],
  }));
  await writeFile(path.join(sceneRoot, 'preview.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#69482f"/></svg>');

  return wallpaperRoot;
}

export async function runFocusCheck(win, settings, fixtureRoot) {
  const inspect = source => win.webContents.executeJavaScript(source, true);
  const evidence = {};
  async function until(expression, description, timeout = 12000) {
    console.log('FOCUS_STEP', description);
    const deadline = Date.now() + timeout;
    do {
      if (await inspect(expression)) return;
      await delay(70);
    } while (Date.now() < deadline);
    throw new Error(`专注计时验收超时：${description}`);
  }
  const click = selector => inspect(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const currentId = `(() => {
    const title = document.querySelector('#currentWallpaper')?.textContent;
    return ${JSON.stringify(BUILTINS)}.find(item => item.title === title)?.id || null;
  })()`;
  const setClock = milliseconds => inspect(`window.__focusQaClock.value += ${milliseconds}`);
  async function advance(milliseconds) {
    await setClock(milliseconds);
    await delay(380);
  }
  async function measureAnimationFrames(count = 90, scroll = false) {
    console.log('FOCUS_FRAME_SAMPLE', count, scroll);
    return inspect(`new Promise(resolve => {
      const intervals = [];
      let previous = 0;
      let frames = 0;
      const scroller = ${scroll} && document.querySelector(".wb-main");
      const maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      const sample = timestamp => {
        if (previous) intervals.push(timestamp - previous);
        previous = timestamp;
        frames += 1;
        if (scroller) scroller.scrollTop = (1 - Math.cos(frames / 9)) * maxScroll / 2;
        if (frames <= ${count}) requestAnimationFrame(sample);
        else {
          intervals.sort((left, right) => left - right);
          const total = intervals.reduce((sum, value) => sum + value, 0);
          resolve({
            frames: intervals.length,
            averageMs: total / intervals.length,
            p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? null,
            devicePixelRatio,
            scrolledPixels: maxScroll,
            viewport: { width: innerWidth, height: innerHeight }
          });
        }
      };
      requestAnimationFrame(sample);
    })`);
  }

  await until(`Boolean(document.querySelector('#start') && document.querySelector('#wallpaperRotation') && document.querySelector('#wallpaperSound'))`, '新开关与专注计时页');
  await inspect(`(() => {
    window.__focusQaClock = { value: performance.now() };
    Object.defineProperty(performance, 'now', { configurable: true, value: () => window.__focusQaClock.value });
  })()`);

  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '壁纸库打开');
  await inspect(`(() => {
    document.querySelector('[data-filter="all"]')?.click();
    for (const item of ${JSON.stringify(BUILTINS)}) {
      const favorite = [...document.querySelectorAll('.favorite-button')]
        .find(button => button.getAttribute('aria-label')?.endsWith(item.title));
      if (favorite?.getAttribute('aria-pressed') !== 'true') favorite?.click();
    }
    document.querySelector('[data-filter="favorite"]')?.click();
    const sort = document.querySelector('#wallpaperSort');
    if (sort) { sort.value = 'name'; sort.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('#search').value = 'no matching wallpaper';
    document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true }));
    const selected = [...document.querySelectorAll('.wallpaper-select')]
      .find(button => button.getAttribute('aria-label') === '选择 远山 · 静谧时分');
    selected?.click();
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`${currentId} === 'builtin-mountain'`, '测试从收藏分类的第一张背景开始');
  evidence.favoriteFixture = true;

  const rotation = await inspect(`document.querySelector('#wallpaperRotation').getAttribute('aria-pressed')`);
  if (rotation !== 'true') await click('#wallpaperRotation');
  await until(`document.querySelector('#wallpaperRotation').getAttribute('aria-pressed') === 'true'`, '轮播开关启用');

  await advance(120000);
  assert.equal(await inspect(currentId), 'builtin-mountain', '计时未开始时不应轮播背景');
  await click('#start');
  await until(`document.querySelector('#startText')?.textContent.includes('暂停')`, '番茄钟开始');
  await advance(59999);
  assert.equal(await inspect(currentId), 'builtin-mountain', '未满一分钟时保持当前背景');
  await advance(1);
  await until(`${currentId} === 'builtin-night'`, '一分钟后按选定分类顺序切换');
  await advance(60000);
  await until(`${currentId} === 'builtin-dawn'`, '第二次切换继续按顺序播放');
  await advance(60000);
  await until(`${currentId} === 'builtin-mountain'`, '分类队列播放到末尾后从头循环');
  evidence.rotationOrderAndWrap = true;

  await click('#start');
  await until(`document.querySelector('#startText')?.textContent.includes('继续')`, '番茄钟暂停');
  const pausedAt = await inspect(currentId);
  await advance(120000);
  assert.equal(await inspect(currentId), pausedAt, '番茄钟暂停时背景不应切换');
  await click('#start');
  await advance(60000);
  await until(`${currentId} !== ${JSON.stringify(pausedAt)}`, '恢复计时后轮播恢复');
  evidence.pauseResume = true;

  await click('#wallpaperRotation');
  await until(`document.querySelector('#wallpaperRotation').getAttribute('aria-pressed') === 'false'`, '关闭背景轮播');
  const rotationOffAt = await inspect(currentId);
  await advance(120000);
  assert.equal(await inspect(currentId), rotationOffAt, '关闭轮播后不应自动切换');
  evidence.rotationOff = true;

  await click('#start');
  await until(`document.querySelector('#startText')?.textContent.includes('继续')`, '手动换图前暂停计时');
  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '选择手动换图分类');
  const emptyFavoriteSearch = await inspect(`(() => {
    document.querySelector('[data-filter="favorite"]')?.click();
    const search = document.querySelector('#search');
    search.value = 'no matching wallpaper';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const empty = document.querySelector('#libraryGrid')?.children.length === 0;
    document.querySelector('#libraryDialog')?.close();
    return empty;
  })()`);
  assert.equal(emptyFavoriteSearch, true, '测试搜索词在收藏分类下没有匹配壁纸');
  await until(`document.querySelector('#libraryDialog')?.open === false && document.querySelector('[data-filter="favorite"]')?.classList.contains('active')`, '保留收藏分类');
  const wallpaperOrder = BUILTINS.map(item => item.id);
  const startingIndex = wallpaperOrder.indexOf(await inspect(currentId));
  assert.notEqual(startingIndex, -1, '手动换图测试从已收藏背景开始');
  const expectedForward = [1, 2, 3].map(step => wallpaperOrder[(startingIndex + step) % wallpaperOrder.length]);
  for (const id of expectedForward) {
    await click('#nextWallpaper');
    await until(`${currentId} === ${JSON.stringify(id)}`, `手动切换下一张 ${id}`);
  }
  const expectedBackward = [1, 2, 3].map(step => wallpaperOrder[(startingIndex - step + wallpaperOrder.length) % wallpaperOrder.length]);
  for (const id of expectedBackward) {
    await click('#prevWallpaper');
    await until(`${currentId} === ${JSON.stringify(id)}`, `手动切换上一张 ${id}`);
  }
  assert.equal(await inspect(`document.querySelector('#wallpaperRotation').getAttribute('aria-pressed')`), 'false', '手动换图不需要开启自动轮播');
  evidence.manualSequenceWrapWithoutTimerAndAcrossEmptySearch = true;

  const originalSize = win.getSize();
  win.setSize(720, 620);
  await until(`(() => {
    if (Math.abs(innerWidth - 720) > 3 || Math.abs(innerHeight - 620) > 3) return false;
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const prev = rect('prevWallpaper'), next = rect('nextWallpaper'), random = rect('random');
    return prev.width > 0 && prev.left >= 0 && prev.bottom <= innerHeight &&
      prev.right <= next.left && next.right <= random.left && random.right <= innerWidth;
  })()`, '720×620 窗口中上一张和下一张紧邻随机切换左侧');
  evidence.manualButtonsFitNarrowWindow = true;
  if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'focus-controls-720x620.png'), (await win.capturePage()).toPNG());
  win.setSize(...originalSize);

  const singleWallpaper = await inspect(currentId);
  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '准备单张收藏分类');
  await inspect(`(() => {
    document.querySelector('[data-filter="favorite"]')?.click();
    const search = document.querySelector('#search');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    for (const item of ${JSON.stringify(BUILTINS)}) {
      if (item.id === ${JSON.stringify(singleWallpaper)}) continue;
      const favorite = [...document.querySelectorAll('.favorite-button')]
        .find(button => button.getAttribute('aria-label')?.endsWith(item.title));
      if (favorite?.getAttribute('aria-pressed') === 'true') favorite.click();
    }
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`document.querySelector('#libraryDialog')?.open === false`, '单张分类保存');
  await click('#nextWallpaper');
  assert.equal(await inspect(currentId), singleWallpaper, '只有一张符合分类的背景时下一张保持当前图');
  await click('#prevWallpaper');
  assert.equal(await inspect(currentId), singleWallpaper, '只有一张符合分类的背景时上一张保持当前图');
  evidence.manualNavigationWithSingleWallpaper = true;

  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '恢复收藏测试数据');
  await inspect(`(() => {
    document.querySelector('[data-filter="all"]')?.click();
    for (const item of ${JSON.stringify(BUILTINS)}) {
      const favorite = [...document.querySelectorAll('.favorite-button')]
        .find(button => button.getAttribute('aria-label')?.endsWith(item.title));
      if (favorite?.getAttribute('aria-pressed') !== 'true') favorite?.click();
    }
    document.querySelector('#libraryDialog')?.close();
  })()`);

  const soundBefore = await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`);
  const backgroundSoundBefore = await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`);
  await click('#wallpaperSound');
  await until(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed') !== ${JSON.stringify(backgroundSoundBefore)}`, '背景声音开关响应');
  assert.equal(await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`), soundBefore, '背景声音开关不应改变计时结束提示音');
  const backgroundSound = await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`);
  await click('#sound');
  await until(`document.querySelector('#sound').getAttribute('aria-pressed') !== ${JSON.stringify(soundBefore)}`, '计时提示音开关响应');
  assert.equal(await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`), backgroundSound, '计时结束提示音开关不应改变背景声音');
  await click('#settingsButton');
  await until(`document.querySelector('#settingsDialog')?.open`, '计时设置打开');
  assert.equal(await inspect(`String(document.querySelector('#soundSetting').checked)`), await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`), '设置中的结束提示音应与计时页开关同步');
  await click('#settingsDialog [data-close="settingsDialog"]');
  await click('#start');
  await click('#reset');
  evidence.soundControlsIndependent = true;

  if (await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`) !== 'false') {
    await click('#wallpaperSound');
  }
  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '音频网页壁纸库打开');
  await inspect(`(() => {
    document.querySelector('[data-filter="web"]')?.click();
    const search = document.querySelector('#search');
    search.value = ${JSON.stringify(AUDIO_TITLE)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.wallpaper-select')]
      .find(button => button.getAttribute('aria-label') === ${JSON.stringify('选择 ' + AUDIO_TITLE)})?.click();
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(AUDIO_TITLE)} && document.querySelector('#wallpaperKind')?.textContent === '网页实时'`, '本地网页壁纸启动');
  const frameDeadline = Date.now() + 10000;
  let audioFrame;
  do {
    audioFrame = win.webContents.mainFrame.frames.find(frame => frame.url.includes('stilltime-wallpaper.invalid'));
    if (audioFrame) break;
    await delay(80);
  } while (Date.now() < frameDeadline);
  assert.ok(audioFrame, '本地网页壁纸的隔离 iframe 已创建');
  await audioFrame.executeJavaScript(`document.querySelector('#fixture-audio').play().then(() => true)`, true);
  async function waitAudible(expected) {
    const deadline = Date.now() + 5000;
    do {
      if (win.webContents.isCurrentlyAudible() === expected) return;
      await delay(80);
    } while (Date.now() < deadline);
    assert.equal(win.webContents.isCurrentlyAudible(), expected, `网页背景音应为 ${expected ? '播放' : '静音'}`);
  }
  await waitAudible(false);
  evidence.webAudioInitiallyMuted = true;

  await click('#wallpaperSound');
  await waitAudible(true);
  evidence.webAudioEnabled = true;
  const soundStateDuringWebAudio = await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`);
  await click('#sound');
  await waitAudible(true);
  assert.notEqual(await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`), soundStateDuringWebAudio);
  evidence.endChimeIndependentOfWebAudio = true;
  await click('#sound');

  await click('#wallpaperSound');
  await waitAudible(false);
  evidence.webAudioMutedAtRuntime = true;
  const finalWallpaperSound = await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`);
  const stateDeadline = Date.now() + 3000;
  let savedState = await inspect('window.stilltimeDesktop.loadState()');
  while (savedState.wallpaperSound !== (finalWallpaperSound === 'true') && Date.now() < stateDeadline) {
    await delay(50);
    savedState = await inspect('window.stilltimeDesktop.loadState()');
  }
  assert.equal(savedState.wallpaperSound, finalWallpaperSound === 'true', '网页背景声音设置写入隔离设置目录');
  assert.equal(savedState.wallpaperCategory, 'web', '当前背景分类写入隔离设置目录');
  assert.equal(savedState.wallpaperRotation, false, '轮播关闭状态写入隔离设置目录');
  assert.equal(savedState.sortBy, 'name', '壁纸排序写入隔离设置目录');
  for (const item of BUILTINS) assert.ok(savedState.favorites.includes(item.id), `收藏状态已保存：${item.id}`);
  evidence.soundPreferencePersisted = true;

  const audioWallpaperWasSelected = await inspect(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(AUDIO_TITLE)}`);
  assert.equal(audioWallpaperWasSelected, true, '测试用网页壁纸仍处于活动状态');
  await inspect(`(() => {
    document.querySelector('#wallpaperButton').click();
    document.querySelector('[data-filter="all"]')?.click();
    const search = document.querySelector('#search');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const selected = [...document.querySelectorAll('.wallpaper-select')]
      .find(button => button.getAttribute('aria-label') === '选择 远山 · 静谧时分');
    selected?.click();
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`document.querySelector('#currentWallpaper')?.textContent === '远山 · 静谧时分'`, '切回内置背景');
  await waitAudible(false);

  await click('#wallpaperButton');
  await until(`document.querySelector('#libraryDialog')?.open`, '重新打开音频壁纸库');
  await inspect(`(() => {
    document.querySelector('[data-filter="web"]')?.click();
    const search = document.querySelector('#search');
    search.value = ${JSON.stringify(AUDIO_TITLE)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.wallpaper-select')]
      .find(button => button.getAttribute('aria-label') === ${JSON.stringify('选择 ' + AUDIO_TITLE)})?.click();
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(AUDIO_TITLE)} && document.querySelector('#wallpaperKind')?.textContent === '网页实时'`, '重新启动网页音频夹具');
  const webAudioDeadline = Date.now() + 8000;
  do {
    audioFrame = win.webContents.mainFrame.frames.find(frame => frame.url.includes('stilltime-wallpaper.invalid'));
    if (audioFrame) break;
    await delay(70);
  } while (Date.now() < webAudioDeadline);
  assert.ok(audioFrame, '网页壁纸音频 iframe 可再次获取');
  await audioFrame.executeJavaScript(`(async () => {
    document.querySelector('#fixture-audio').pause();
    const context = new AudioContext();
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.value = 0.16;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    window.__focusQaContext = context;
    window.__focusQaOscillator = oscillator;
    return true;
  })()`, true);
  await waitAudible(false);
  evidence.webAudioApiInitiallyMuted = true;
  await click('#wallpaperSound');
  await waitAudible(true);
  evidence.webAudioApiEnabled = true;
  await click('#wallpaperSound');
  await waitAudible(false);
  evidence.webAudioApiMutedAtRuntime = true;
  await click('#wallpaperSound');
  await waitAudible(true);
  const oscillatorSoundState = await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`);
  await click('#sound');
  await waitAudible(true);
  assert.notEqual(await inspect(`document.querySelector('#sound').getAttribute('aria-pressed')`), oscillatorSoundState);
  evidence.endChimeIndependentOfWebAudioApi = true;
  await click('#sound');
  await click('#wallpaperSound');
  await waitAudible(false);
  await audioFrame.executeJavaScript(`(() => {
    window.__focusQaOscillator?.stop();
    return window.__focusQaContext?.close();
  })()`);

  evidence.focusAnimationFrames = await measureAnimationFrames();

  await click('#backToWorkbench');
  await until('document.body.classList.contains("workbench-active")', '从专注返回经典工作台');
  await until('document.querySelector("#backgroundWeb").hidden', '经典实体工作台停止实时网页壁纸');
  await click('#wb-appearance');
  await until('!document.querySelector("#wb-appearance-panel").hidden', '打开外观设置');
  await click('[data-material-choice="glass"]');
  await until('document.documentElement.dataset.material === "glass"', '选择原生毛玻璃');
  await click('.wb-focus-nav');
  await until('!document.body.classList.contains("workbench-active")', '从毛玻璃工作台返回专注');
  await until(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(AUDIO_TITLE)} &&
    document.querySelector('#wallpaperKind')?.textContent === '网页实时'`, '重新启动网页壁纸音频夹具');

  audioFrame = win.webContents.mainFrame.frames.find(frame => frame.url.includes('stilltime-wallpaper.invalid'));
  assert.ok(audioFrame, '毛玻璃测试使用本地实时壁纸 iframe');
  const frameTreeNodeId = audioFrame.frameTreeNodeId;
  const audibleInFocus = await inspect(`document.querySelector('#wallpaperSound').getAttribute('aria-pressed')`);
  if (audibleInFocus !== 'true') await click('#wallpaperSound');
  await waitAudible(true);
  const initialAudioTime = await audioFrame.executeJavaScript(`document.querySelector('#fixture-audio').currentTime`, true);
  await click('#backToWorkbench');
  await until('document.body.classList.contains("workbench-active") && document.documentElement.dataset.material === "glass"', '进入透壁纸毛玻璃工作台');
  await waitAudible(false);
  await delay(450);
  assert.equal(
    win.webContents.mainFrame.frames.find(frame => frame.url.includes('stilltime-wallpaper.invalid'))?.frameTreeNodeId,
    frameTreeNodeId,
    '切入毛玻璃工作台复用原网页壁纸 iframe',
  );
  const advancedAudioTime = await audioFrame.executeJavaScript(`document.querySelector('#fixture-audio').currentTime`, true);
  const audioProgress = (advancedAudioTime - initialAudioTime + 2) % 2;
  assert.ok(audioProgress > 0.15 && audioProgress < 1.5,
    '毛玻璃工作台保持壁纸播放进度');
  evidence.glassWorkbenchMutedWithoutRestart = true;

  await click('.wb-nav [data-wb-nav="links"]');
  await until('!document.querySelector("#wb-links").hidden', '打开毛玻璃链接库');
  await click('.wb-nav [data-wb-nav="home"]');
  await until('!document.querySelector("#wb-home").hidden', '返回毛玻璃首页');
  assert.equal(
    win.webContents.mainFrame.frames.find(frame => frame.url.includes('stilltime-wallpaper.invalid'))?.frameTreeNodeId,
    frameTreeNodeId,
    '工作台子页切换期间不重建壁纸 iframe',
  );
  evidence.glassSubpageReuse = true;
  evidence.glassWorkbenchAnimationFrames = await measureAnimationFrames();

  await click('#wb-appearance');
  await click('[data-material-choice="solid"]');
  await until('document.documentElement.dataset.material === "solid"', '切回经典实体');
  await until('document.querySelector("#backgroundWeb").hidden', '经典实体停止实时网页壁纸');
  assert.equal(win.webContents.isCurrentlyAudible(), false, '实体工作台停止网页壁纸声音');
  evidence.solidStopsWallpaper = true;

  await click('#wb-appearance');
  await inspect(`(() => {
    document.querySelector('[data-material-choice="glass"]').click();
    document.querySelector('[data-material-choice="solid"]').click();
    document.querySelector('[data-material-choice="glass"]').click();
  })()`);
  await until('document.documentElement.dataset.material === "glass"', '快速双向切换后最终保持毛玻璃');
  await click('.wb-focus-nav');
  await until('!document.body.classList.contains("workbench-active")', '玻璃状态下重新进入专注');
  await until(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(AUDIO_TITLE)} &&
    document.querySelector('#wallpaperKind')?.textContent === '网页实时'`, '专注页恢复原网页壁纸');
  await waitAudible(true);
  evidence.focusRestoresWallpaperAudio = true;

  await click('#wallpaperButton');
  await until('document.querySelector("#libraryDialog")?.open', '打开壁纸库选择视频夹具');
  await inspect(`(() => {
    document.querySelector('[data-filter="video"]')?.click();
    const search = document.querySelector('#search');
    search.value = ${JSON.stringify(VIDEO_TITLE)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.wallpaper-select')]
      .find(button => button.getAttribute('aria-label') === ${JSON.stringify('选择 ' + VIDEO_TITLE)})?.click();
    document.querySelector('#libraryDialog')?.close();
  })()`);
  await until(`document.querySelector('#currentWallpaper')?.textContent === ${JSON.stringify(VIDEO_TITLE)} &&
    !document.querySelector('#backgroundVideo').hidden && document.querySelector('#backgroundVideo').currentTime > 0.3`,
    '合成视频壁纸在专注页播放');
  const videoStartedAt = await inspect('document.querySelector("#backgroundVideo").currentTime');
  await inspect('window.__v22VideoElement = document.querySelector("#backgroundVideo")');
  await click('#backToWorkbench');
  await until('document.body.classList.contains("workbench-active") && document.documentElement.dataset.material === "glass"', '视频持续显示于毛玻璃工作台');
  await waitAudible(false);
  await delay(500);
  assert.equal(await inspect('document.querySelector("#backgroundVideo") === window.__v22VideoElement'), true,
    '返回工作台时复用页面中的视频元素');
  await click('.wb-nav [data-wb-nav="links"]');
  await until('!document.querySelector("#wb-links").hidden', '视频播放期间打开链接库');
  assert.ok(await inspect(`document.querySelector('#backgroundVideo').currentTime > ${videoStartedAt + 0.3}`),
    '毛玻璃子页切换期间视频进度继续');
  evidence.glassVideoProgressContinues = true;
  await click('#wb-appearance');
  await click('[data-material-choice="solid"]');
  await until('document.documentElement.dataset.material === "solid" && document.querySelector("#backgroundVideo").paused',
    '切回实体后暂停动态壁纸');
  evidence.solidPausesVideo = true;

  await click('#wb-appearance');
  await click('[data-material-choice="glass"]');
  await until('document.documentElement.dataset.material === "glass"', '视频壁纸下切回毛玻璃');
  await click('.wb-focus-nav');
  await until('!document.body.classList.contains("workbench-active") && !document.querySelector("#backgroundVideo").paused',
    '切回专注后恢复视频播放');
  assert.equal(await inspect('window.__v22VideoElement === document.querySelector("#backgroundVideo")'), true,
    '专注和工作台共用同一个视频元素');
  evidence.focusResumesVideo = true;

  await click('#backToWorkbench');
  await click('.wb-nav [data-wb-nav="home"]');
  await until("!document.querySelector('#wb-home').hidden", '测量前返回首页');
  const previousSize = win.getSize();
  try {
    win.setSize(1024, 700);
    await until("window.innerWidth <= 1024 && document.querySelector('.wb-main').scrollHeight > document.querySelector('.wb-main').clientHeight", '短窗口可滚动');
    evidence.videoGlassScrollFrames = await measureAnimationFrames(90, true);
    const setMaterial = async material => {
      await click('#wb-appearance');
      await click('[data-material-choice=' + material + ']');
      await click('#wb-appearance');
    };
    await setMaterial('solid');
    await until("document.querySelector('#backgroundVideo').paused", '测量实体模式前视频已暂停');
    evidence.videoSolidScrollFrames = await measureAnimationFrames(90, true);
    await setMaterial('glass');
    await until("!document.querySelector('#backgroundVideo').paused", '恢复毛玻璃播放');
  } finally {
    win.setSize(...previousSize);
  }

  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  try {
    const emulate = features => devtools.sendCommand('Emulation.setEmulatedMedia', { features });
    const videoPaused = "document.querySelector('#backgroundVideo').paused";
    const overlayHidden = "getComputedStyle(document.querySelector('#wallpaper-glass-overlay')).display === 'none'";
    await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await until(videoPaused + " && !document.querySelector('#backgroundImage').hidden", '减少动态效果显示预览');
    await emulate([{ name: 'forced-colors', value: 'active' }]);
    await until(videoPaused + ' && ' + overlayHidden, '强制颜色使用实体表面');
    await emulate([{ name: 'prefers-reduced-transparency', value: 'reduce' }]);
    await until(videoPaused + ' && ' + overlayHidden, '减少透明度使用实体表面');
    assert.equal(await inspect('localStorage.getItem("ui_material")'), 'glass');
    await emulate([]);
  } finally {
    devtools.detach();
  }
  await until("!document.querySelector('#backgroundVideo').paused", '关闭辅助显示偏好后恢复视频');
  evidence.accessibleGlassFallbacks = true;

  win.minimize();
  try {
    await until("document.querySelector('#backgroundVideo').paused && !document.querySelector('#backgroundVideo').hasAttribute('src')", '最小化时释放动态壁纸');
  } finally {
    win.restore();
  }
  await until("!document.querySelector('#backgroundVideo').paused && !document.querySelector('#backgroundVideo').hidden", '窗口恢复时重播壁纸');
  evidence.glassVideoMinimizeRestore = true;

  await click('.wb-focus-nav');
  await click('#wallpaperButton');
  await until('document.querySelector("#libraryDialog")?.open', '打开壁纸库选择合成场景');
  await inspect(`(() => {
    document.querySelector('[data-filter="scene"]').click();
    const search = document.querySelector('#search');
    search.value = 'V22 Scene Fixture';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.wallpaper-select[aria-label="选择 V22 Scene Fixture"]').click();
    document.querySelector('#libraryDialog').close();
  })()`);
  const sceneReady = "document.querySelector('#wallpaperKind')?.textContent === '场景实时渲染' && document.querySelector('#backgroundWeb')?.contentDocument?.querySelector('#sceneCanvas')?.dataset.status === 'ready'";
  const sceneMarker = "document.querySelector('#backgroundWeb').contentWindow.__glassSceneVerification";
  await until(sceneReady, '合成场景播放器已渲染', 22000);
  await inspect(sceneMarker + ' = true');
  await click('#backToWorkbench');
  await click('.wb-nav [data-wb-nav="links"]');
  await until("!document.querySelector('#wb-links').hidden && " + sceneReady, '链接库继续渲染场景壁纸');
  assert.equal(await inspect(sceneMarker), true);
  if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'glass-scene-links.png'), (await win.capturePage()).toPNG());
  await click('.wb-focus-nav');
  await until(sceneReady, '回到专注保留场景播放器');
  assert.equal(await inspect(sceneMarker), true);
  evidence.glassSceneKeepsPlayer = true;

  await click('#wallpaperButton');
  await until('document.querySelector("#libraryDialog")?.open', '在专注页打开壁纸库');
  const selectImage = '.wallpaper-select[aria-label="选择 ' + IMAGE_TITLE + '"]';
  await inspect(`(() => {
    document.querySelector('[data-filter="all"]').click();
    const search = document.querySelector('#search');
    search.value = ${JSON.stringify(IMAGE_TITLE)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(`document.querySelector(${JSON.stringify(selectImage)})`, '普通图片在壁纸库可选');
  await click(selectImage);
  await inspect('document.querySelector("#libraryDialog").close()');
  const imageLoaded = `document.querySelector('#currentWallpaper').textContent === ${JSON.stringify(IMAGE_TITLE)}
    && document.querySelector('#backgroundImage').complete && document.querySelector('#backgroundImage').naturalWidth === 1200`;
  await until(imageLoaded, '专注页显示测试图片');
  await delay(380);
  if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'adjustable-glass-focus.png'), (await win.capturePage()).toPNG());
  const focusImage = await inspect('document.querySelector("#backgroundImage").currentSrc');
  await click('#backToWorkbench');
  await click('.wb-nav [data-wb-nav="links"]');
  await until(`!document.querySelector('#wb-links').hidden && ${imageLoaded}`, '链接库透出专注页正在使用的图片');
  assert.equal(await inspect('document.querySelector("#backgroundImage").currentSrc'), focusImage);
  await click('#wb-appearance');
  await click('[data-mode-choice="dark"]');
  await until('document.documentElement.dataset.theme === "dark"', '使用参考图的深色模式');
  await delay(400);
  if (fixtureRoot) await writeFile(path.join(fixtureRoot, 'adjustable-glass-panel.png'), (await win.capturePage()).toPNG());
  await click('#wb-appearance');

  const detail = bytes => {
    let sum = 0;
    for (let index = 16; index < bytes.length; index += 4) sum += Math.abs(bytes[index] - bytes[index - 16]);
    return Number((sum / (bytes.length / 4 - 4)).toFixed(2));
  };
  async function sampleGlass(radius) {
    await delay(400);
    if (fixtureRoot) await writeFile(path.join(fixtureRoot, `adjustable-glass-links-${radius}.png`), (await win.capturePage()).toPNG());
    const { inside, outside } = await inspect(`(() => {
      const panel = document.querySelector('#wb-links .web-collection__directory').getBoundingClientRect();
      const inside = { x: Math.round(panel.x + 28), y: Math.round(panel.bottom - 13), width: Math.floor(panel.width - 56), height: 2 };
      const outsideY = Math.min(Math.round(panel.bottom + 4), innerHeight - 3);
      return { inside, outside: outsideY > panel.bottom ? { ...inside, y: outsideY } : null };
    })()`);
    assert.ok(outside, '链接库底部须有可采样的壁纸留边');
    return {
      panelDetail: detail((await win.capturePage(inside)).toBitmap()),
      backdropDetail: detail((await win.capturePage(outside)).toBitmap()),
    };
  }
  const adjusted = {};
  for (const radius of [0, 24, 48]) {
    await click('#wb-appearance');
    const slider = await inspect(`(() => {
      const range = document.querySelector('#wb-glass-blur');
      const { x, y, width, height } = range.getBoundingClientRect();
      return { left: Math.round(x + 4), middle: Math.round(x + width / 2),
        right: Math.round(x + width - 4), y: Math.round(y + height / 2) };
    })()`);
    const x = radius === 0 ? slider.left : radius === 48 ? slider.right : slider.middle;
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: radius === 48 ? slider.middle : x, y: slider.y });
    if (radius === 48) win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x, y: slider.y });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y: slider.y });
    await until(`document.querySelector('#wb-glass-blur').value === '${radius}' && localStorage.getItem('ui_material_blur') === '${radius}'`, `鼠标调到 ${radius}px 并保存`);
    await click('#wb-appearance');
    adjusted[radius] = await sampleGlass(radius);
  }
  assert.ok(adjusted[0].panelDetail > adjusted[48].panelDetail * 1.5, '面板内实际像素细节随滑块降低');
  assert.equal(adjusted[0].backdropDetail, adjusted[48].backdropDetail, '面板外实际壁纸像素细节保持');
  evidence.adjustableGlassPixelSamples = adjusted;

  if (fixtureRoot) {
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, 'focus-verification.json'), JSON.stringify({ ...evidence, passed: true }, null, 2) + '\n');
  }
  console.log('专注计时、背景切换与声音开关验收完成');
}
