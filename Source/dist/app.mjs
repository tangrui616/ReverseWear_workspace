import { Countdown, formatTime } from './timer.mjs';
import { loadLocalLibrary, fromFiles } from './library.mjs';
import { createWorkbenchIcon, renderWorkbenchIcons } from './icons.mjs';
import { initialWorkspaceState, isStartupActive, markStartupFocusReady } from './startup/entry.mjs';
const $ = (id) => document.getElementById(id);
renderWorkbenchIcons(document);
for (const [id, name] of Object.entries({ reset: 'reset', fullscreen: 'fullscreen', settingsButton: 'sliders', random: 'shuffle', prevWallpaper: 'chevronLeft', nextWallpaper: 'chevronRight', zen: 'fullscreen', pickFiles: 'upload' })) {
  const button = $(id);
  const icon = createWorkbenchIcon(name);
  const existing = button?.querySelector('svg');
  if (icon && existing) existing.replaceWith(icon);
}
const wallpaperIcon = createWorkbenchIcon('image');
if (wallpaperIcon) $('wallpaperButton')?.querySelector('svg')?.replaceWith(wallpaperIcon);
$('search').parentElement.querySelector('svg').replaceWith(createWorkbenchIcon('search'));
document.querySelectorAll('.close-button').forEach(button => button.replaceChildren(createWorkbenchIcon('close')));
function fitWebWallpaper() { document.documentElement.style.setProperty('--web-scale', String(Math.max(innerWidth / 1920, innerHeight / 1080))); }
window.addEventListener('resize', fitWebWallpaper); fitWebWallpaper();
const desktop = window.stilltimeDesktop;
let renderActive = await desktop.risk.getRenderActivity();
const saved = await initialWorkspaceState;
const timer = new Countdown(saved.timer);
let title = saved.title === '给此刻，留一点白。' ? '给此刻，专注一点。' : saved.title || '给此刻，专注一点。';
let soundEnabled = saved.sound !== false;
let dim = Number.isFinite(saved.dim) ? Math.max(0, Math.min(80, saved.dim)) : 35;
let favorites = new Set(Array.isArray(saved.favorites) ? saved.favorites.filter(x => typeof x === 'string') : []);
let currentId = null;
let pendingWallpaperId = null;
let library = [];
const WALLPAPER_CATEGORIES = new Set(['all', 'video', 'scene', 'web', 'preview', 'favorite']);
const WALLPAPER_ROTATION_MS = 60000;
let filter = WALLPAPER_CATEGORIES.has(saved.wallpaperCategory) ? saved.wallpaperCategory : 'all';
let rotationEnabled = saved.wallpaperRotation === true;
let wallpaperSoundEnabled = saved.wallpaperSound === true;
let nextRotationAt = null;
let rotationCursor = null;
const SORT_OPTIONS = new Set(['created', 'fileName', 'name', 'modified', 'size']);
let sortBy = SORT_OPTIONS.has(saved.sortBy) ? saved.sortBy : 'created';
let pageSize = 32;
let selectToken = 0;
let liveSession = null;
let liveStartQueue = Promise.resolve();
let liveStatusTimer = null;
let liveStatusPending = false;
let liveReadyTimer = null;
let liveMessageHandler = null;
let sceneReadyTimer = null;
let sceneMessageHandler = null;
let sceneFrameToken = 0;
let sceneCheck = null;
const requestedWallpaperId = new URLSearchParams(location.search).get('wallpaper');
let requestedWallpaperApplied = false;
let timeMode = timer.mode;
let toastTimeout;
let audioContext;
let busy = false;
let desktopLibrary = [];
let importedMedia = [];
let initialSelection = true;
let saveErrorShown = false;
let preferredWallpaperId = saved.wallpaperId;
const focusVisible = () => !document.body.classList.contains('workbench-active');
const wallpaperHost = $('backdrop');
const glassMedia = matchMedia('(prefers-reduced-transparency: no-preference) and (forced-colors: none)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const supportsGlass = CSS.supports('backdrop-filter', 'blur(1px)');

function wallpaperMode() {
  if (focusVisible()) return 'live';
  if (document.documentElement.dataset.material !== 'glass' || !supportsGlass || !glassMedia.matches) return 'hidden';
  return reducedMotion.matches ? 'preview' : 'live';
}

const wallpaperAudioEnabled = () => focusVisible() && wallpaperSoundEnabled;
let previousWallpaperMode = wallpaperMode();
wallpaperHost.inert = !focusVisible();
const builtins = [
  { id: 'builtin-mountain', title: '远山 · 静谧时分', type: 'builtin', kind: 'image', previewUrl: 'landscape.svg', mediaUrl: 'landscape.svg' },
  { id: 'builtin-night', title: '远山 · 深夜微光', type: 'builtin', kind: 'image', previewUrl: 'landscape.svg', mediaUrl: 'landscape.svg', tone: 'hue-rotate(25deg) saturate(.55) brightness(.65)' },
  { id: 'builtin-dawn', title: '远山 · 晨雾初醒', type: 'builtin', kind: 'image', previewUrl: 'landscape.svg', mediaUrl: 'landscape.svg', tone: 'hue-rotate(-18deg) saturate(.7) brightness(1.18)' },
];
function persist() {
  if (initialSelection) return;
  desktop.saveState({ timer: timer.serialize(), title, sound: soundEnabled, dim, favorites: [...favorites], wallpaperId: preferredWallpaperId, sortBy,
    wallpaperCategory: filter, wallpaperRotation: rotationEnabled, wallpaperSound: wallpaperSoundEnabled,
  }).catch(() => {
    if (!saveErrorShown) toast('无法保存设置，请检查工作台设置目录。');
    saveErrorShown = true;
  });
}
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('toast').classList.remove('show'), 4200); }
function durationLabel(ms) { const seconds = Math.round(ms / 1000); if (seconds % 3600 === 0) return `${seconds / 3600} 小时`; if (seconds % 60 === 0) return `${seconds / 60} 分钟`; return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function localTime(timestamp) { return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function renderTimer() {
  const parts = formatTime(timer.remaining);
  const text = parts.join(':');
  const signature = `${text}-${timer.running}-${timer.completed}-${timer.mode}`;
  if ($('timer').dataset.signature !== signature) {
    $('timer').replaceChildren();
    parts.forEach((part, i) => { if (i) { const colon = document.createElement('span'); colon.className = 'time-colon'; colon.textContent = ':'; $('timer').append(colon); } $('timer').append(document.createTextNode(part)); });
    $('timer').dataset.signature = signature;
    $('timer').classList.toggle('long', parts.length > 2);
    $('timer').setAttribute('aria-label', `剩余 ${text}`);
    $('startText').textContent = timer.running ? '暂停片刻' : timer.completed ? '再来一次' : timer.remaining < timer.total - 500 ? '继续专注' : '开始专注';
    const icon = createWorkbenchIcon(timer.running ? 'pause' : 'play');
    if (icon) { icon.id = 'playIcon'; $('playIcon').replaceWith(icon); }
    $('timerState').textContent = timer.completed ? '这一刻，圆满完成' : timer.running ? '正在专注，慢慢来就好' : timer.remaining < timer.total - 500 ? (timer.mode === 'deadline' ? '已暂停 · 截止时间保持不变' : '休息片刻，随时继续') : '准备好，开始一段专注时光';
    document.body.classList.toggle('completed', timer.completed);
  }
  const displayTitle = timer.running ? `${text} · ${title} | 反穿衣工作台` : timer.completed ? '专注完成 · 反穿衣工作台' : focusVisible() ? '反穿衣工作台 · 壁纸倒计时' : '反穿衣工作台';
  if (document.title !== displayTitle) document.title = displayTitle;
  updateWallpaperRotation();
  window.dispatchEvent(new CustomEvent('stilltime-timer-state', { detail: { text, running: timer.running, completed: timer.completed } }));
  $('endsAt').textContent = timer.mode === 'deadline' ? `${localTime(timer.deadline)} 截止` : timer.running ? `${localTime(timer.endAt)} 结束` : durationLabel(timer.total);
  $('progress').style.width = `${Math.max(0, Math.min(100, (1 - timer.remaining / timer.total) * 100))}%`;
  document.querySelectorAll('[data-minutes]').forEach(button => button.classList.toggle('active', timer.mode === 'duration' && timer.total === Number(button.dataset.minutes) * 60000));
}
function initAudio() { try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); if (audioContext.state === 'suspended') audioContext.resume().catch(() => {}); } catch {} }
function chime() {
  if (!soundEnabled) return;
  try {
    initAudio();
    [523.25, 659.25, 783.99].forEach((frequency, i) => {
      const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); const at = audioContext.currentTime + i * .25;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.13, at + .03); gain.gain.exponentialRampToValueAtTime(.001, at + 1.5);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(at); oscillator.stop(at + 1.6);
    });
  } catch {}
}
function toggleTimer() { initAudio(); try { timer.toggle(); } catch (error) { toast(error.message); openSettings(); } persist(); renderTimer(); }
function updateSound() {
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').title = `结束提示音已${soundEnabled ? '开启' : '关闭'}`;
  $('soundSetting').checked = soundEnabled;
  const icon = createWorkbenchIcon(soundEnabled ? 'volume' : 'volumeMute');
  if (icon) $('sound').replaceChildren(icon);
}
function wallpaperCategoryLabel() {
  return document.querySelector('[data-filter].active').textContent.replace(/\s*♡$/, '').trim();
}
function renderWallpaperControls() {
  const rotation = $('wallpaperRotation');
  const category = wallpaperCategoryLabel();
  rotation.setAttribute('aria-pressed', String(rotationEnabled));
  rotation.querySelector('span').textContent = rotationEnabled ? `自动换背景 · ${category}` : '自动换背景';
  rotation.title = rotationEnabled ? `计时中每分钟按「${category}」的壁纸库顺序切换` : '开启后每分钟切换背景';

  const sound = $('wallpaperSound');
  sound.setAttribute('aria-pressed', String(wallpaperSoundEnabled));
  sound.title = wallpaperSoundEnabled ? '壁纸声音已开启' : '壁纸声音已关闭';
  sound.querySelector('svg').replaceWith(createWorkbenchIcon(wallpaperSoundEnabled ? 'volume' : 'volumeMute'));
}
function applyWallpaperSound() {
  const enabled = wallpaperAudioEnabled();
  $('backgroundVideo').muted = !enabled;
  const frame = $('backgroundWeb');
  if (!frame.contentWindow) return;
  const message = { type: 'stilltime-wallpaper-sound', enabled };
  if (liveSession) {
    frame.contentWindow.postMessage({ ...message, session: liveSession.session }, new URL(liveSession.frameUrl, location.href).origin);
  } else if (frame.classList.contains('scene-frame')) {
    frame.contentWindow.postMessage(message, location.origin);
  }
}
function updateDim() { document.documentElement.style.setProperty('--dim', String(dim / 100)); $('dimInput').value = String(dim); $('dimValue').textContent = `${dim}%`; }
function setMode(mode) { timeMode = mode; $('durationMode').classList.toggle('active', mode === 'duration'); $('deadlineMode').classList.toggle('active', mode === 'deadline'); $('durationFields').hidden = mode !== 'duration'; $('deadlineFields').hidden = mode !== 'deadline'; }
function openSettings() {
  $('sessionName').value = title;
  const whole = Math.round(timer.total / 1000);
  $('hoursInput').value = String(Math.floor(whole / 3600)); $('minutesInput').value = String(Math.floor(whole % 3600 / 60)); $('secondsInput').value = String(whole % 60);
  const deadline = new Date(timer.deadline > Date.now() ? timer.deadline : Date.now() + 3600000); deadline.setMinutes(deadline.getMinutes() - deadline.getTimezoneOffset());
  $('deadlineInput').value = deadline.toISOString().slice(0, 16);
  setMode(timer.mode); $('settingsError').textContent = ''; $('settingsDialog').showModal();
}
function applySettings() {
  try {
    if (timeMode === 'deadline') { initAudio(); timer.setDeadline(new Date($('deadlineInput').value).getTime()); }
    else {
      const values = ['hoursInput', 'minutesInput', 'secondsInput'].map(id => Number($(id).value));
      if (values.some(n => !Number.isInteger(n) || n < 0) || values[0] > 999 || values[1] > 59 || values[2] > 59) throw new Error('小时为 0–999，分钟和秒为 0–59，请输入整数。');
      timer.setDuration(values[0] * 3600000 + values[1] * 60000 + values[2] * 1000);
    }
    title = $('sessionName').value.trim() || '给此刻，专注一点。'; $('titleButton').textContent = title; soundEnabled = $('soundSetting').checked; updateSound(); persist(); renderTimer(); $('settingsDialog').close();
  } catch (error) { $('settingsError').textContent = error.message; }
}
function typeLabel(item) { return item.type === 'builtin' ? '内置风景' : item.live && item.type === 'web' ? '网页实时' : item.live ? '场景实时' : item.kind === 'video' ? '动态视频' : item.kind === 'image' ? '图片壁纸' : item.type === 'web' ? '网页预览' : '场景预览'; }
async function previewOf(item) { try { return item.getPreview ? await item.getPreview() : item.previewUrl; } catch { return null; } }
async function mediaOf(item) { try { return item.getMedia ? await item.getMedia() : item.mediaUrl; } catch { return null; } }
async function stopLive(session = liveSession) {
  if (!session) return;
  if (liveSession?.session === session.session) {
    liveSession = null;
    clearInterval(liveStatusTimer); liveStatusTimer = null;
    clearTimeout(liveReadyTimer); liveReadyTimer = null;
    const frame = $('backgroundWeb'); frame.onload = null; frame.onerror = null; frame.hidden = true; frame.src = 'about:blank';
    if (liveMessageHandler) { window.removeEventListener('message', liveMessageHandler); liveMessageHandler = null; }
  }
  try { await fetch('/api/live/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: session.session }) }); } catch {}
}
function stopScene() {
  sceneFrameToken++;
  clearTimeout(sceneReadyTimer); sceneReadyTimer = null;
  if (sceneMessageHandler) { window.removeEventListener('message', sceneMessageHandler); sceneMessageHandler = null; }
  const frame = $('backgroundWeb'); frame.onload = null; frame.onerror = null;
  if (frame.src && new URL(frame.src, location.href).pathname === '/wallpapers/player.html') frame.src = 'about:blank';
  frame.classList.remove('scene-frame', 'scene-loading'); frame.hidden = true;
}
function startScene(item, token) {
  const frame = $('backgroundWeb'), fallback = $('backgroundImage');
  const frameToken = ++sceneFrameToken;
  const fail = (reason = 'renderer-failed', detail = '') => {
    if (token !== selectToken || frameToken !== sceneFrameToken) return;
    sceneCheck = { item, reason, detail };
    stopScene();
    fallback.hidden = false;
    $('wallpaperKind').textContent = '场景预览图';
  };
  frame.onload = applyWallpaperSound; frame.onerror = () => fail();
  frame.hidden = false; frame.title = '场景壁纸实时画面'; frame.classList.add('scene-frame', 'scene-loading');
  sceneMessageHandler = event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.id !== item.id || token !== selectToken || frameToken !== sceneFrameToken) return;
    if (event.data.type === 'stilltime-scene-ready') {
      frame.classList.remove('scene-loading'); fallback.hidden = true; $('wallpaperKind').textContent = '场景实时渲染';
      applyWallpaperSound();
      clearTimeout(sceneReadyTimer); sceneReadyTimer = null;
    } else if (event.data.type === 'stilltime-scene-error') fail(event.data.reason, event.data.detail);
  };
  window.addEventListener('message', sceneMessageHandler);
  sceneReadyTimer = setTimeout(() => fail('timeout'), 60000);
  frame.src = `/wallpapers/player.html?id=${encodeURIComponent(item.id)}&sound=${Number(wallpaperAudioEnabled())}`;
}
async function inspectCurrentScene() {
  const check = sceneCheck;
  if (!check) return;
  const dialog = $('sceneDiagnosticsDialog');
  const output = $('sceneDiagnosticsReport');
  output.value = '正在读取场景报告…';
  if (!dialog.open) {
    dialog.showModal();
    clearInterval(sceneReportTimer);
    sceneReportTimer = setInterval(updateSceneReport, 750);
  }
  await updateSceneReport();
}
async function updateSceneReport() {
  const check = sceneCheck;
  const dialog = $('sceneDiagnosticsDialog');
  const output = $('sceneDiagnosticsReport');
  if (!dialog.open || !check) return;
  try {
    const { requests, failures, omitted } = await desktop.inspectScene(check.item.id);
    if (!dialog.open || sceneCheck?.item.id !== check.item.id) return;
    const latest = sceneCheck;
    const reasons = { 'scene-json': '场景配置无法加载', 'no-visible-objects': '没有可绘制的场景对象', 'webgl-context-lost': 'WebGL 上下文中断', timeout: '等待场景画面超时', exception: '渲染器异常', 'load-error': '资源加载失败' };
    const lines = [check.item.title, `已记录的资源请求 ${requests} 次`];
    if (latest.reason) lines.push(`渲染状态  ${reasons[latest.reason] ?? '渲染未完成'}${latest.detail ? ' · ' + latest.detail : ''}`);
    lines.push('');
    if (!failures.length) {
      lines.push(requests ? '未记录到缺失或读取失败的文件。' : '暂无资源请求记录。');
      if (requests) lines.push('如果画面仍异常，可能涉及场景格式、特效或着色器兼容性。');
    } else {
      for (const { name, status } of failures) {
        const statusText = status === 404 ? '找不到资源' : status === 400 ? '资源路径或类型不支持' : status === 403 ? '资源访问被拒绝' : '资源读取失败';
        lines.push(`${status}  ${statusText}  ${name || '未指定资源'}`);
      }
    }
    if (omitted) lines.push('其余失败项已省略。');
    const report = lines.join('\n');
    if (output.value !== report) output.value = report;
  } catch {
    output.value = '无法读取场景报告。';
  }
}
async function startLive(item, preview, token, silent) {
  const job = liveStartQueue.catch(() => {}).then(async () => {
    if (token !== selectToken) return;
    const response = await fetch('/api/live/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, soundEnabled: wallpaperAudioEnabled() }), signal: AbortSignal.timeout(35000) });
    const result = await response.json();
    if (!response.ok || result.mode !== 'web' || typeof result.session !== 'string' || typeof result.frameUrl !== 'string') throw new Error(result.error || '网页壁纸未能启动。');
    if (token !== selectToken) { await stopLive(result); return; }
    liveSession = result;
    const frame = $('backgroundWeb'), fallback = $('backgroundImage');
    frame.title = '网页壁纸实时画面';
    const showLive = () => {
      if (token !== selectToken) return;
      frame.hidden = false; fallback.hidden = true; $('wallpaperKind').textContent = typeLabel(item); clearTimeout(liveReadyTimer); liveReadyTimer = null;
    };
    const fail = async () => {
      if (token !== selectToken) return;
      fallback.hidden = false;
      if (preview) fallback.src = preview;
      $('wallpaperKind').textContent = '网页预览';
      await stopLive(result);
      if (!silent) toast('实时画面暂不可用，已切回壁纸预览图。');
    };
    const frameOrigin = new URL(result.frameUrl, location.href).origin;
    frame.onload = applyWallpaperSound;
    frame.onerror = fail;
    liveReadyTimer = setTimeout(() => { if (frame.hidden) void fail(); }, 35000);
    liveMessageHandler = event => {
      if (event.origin !== frameOrigin || event.source !== frame.contentWindow || event.data?.session !== result.session) return;
      if (event.data.type === 'stilltime-web-ready') { applyWallpaperSound(); showLive(); }
      else if (event.data.type === 'stilltime-web-error') void fail();
    };
    window.addEventListener('message', liveMessageHandler);
    frame.src = result.frameUrl;
    if (!liveStatusTimer) liveStatusTimer = setInterval(async () => {
      if (!liveSession || liveStatusPending) return;
      liveStatusPending = true;
      try {
        const status = await fetch('/api/live/status').then(value => value.json());
        if (status.session !== result.session) return;
        if (!status.active || status.error) void fail();
      } catch {} finally { liveStatusPending = false; }
    }, 5000);
  });
  liveStartQueue = job.catch(() => {});
  return job;
}
async function chooseWallpaper(item, { silent = false, remember = true, rotating = false } = {}) {
  if (!rotating) {
    rotationCursor = null;
    nextRotationAt = null;
  }
  const token = ++selectToken;
  pendingWallpaperId = item.id;
  const preview = await previewOf(item);
  const media = item.kind !== 'preview' ? await mediaOf(item) : null;
  if (token !== selectToken) return;
  pendingWallpaperId = null;
  if (rotating && (!wallpaperRotationActive() || nextRotationAt === null)) return;
  if (rotating) rotationCursor = item.id;
  const url = media || preview;
  const wantsLive = item.live === true && item.type === 'web';
  const wantsScene = item.live === true && item.type === 'scene';
  if (!url && !wantsLive && !wantsScene) { if (!silent) toast('这张壁纸的媒体暂不可读取，请尝试其他壁纸。'); return; }
  if ($('sceneDiagnosticsDialog').open) $('sceneDiagnosticsDialog').close();
  stopScene();
  if (liveSession) void stopLive();
  sceneCheck = item.type === 'scene' ? { item, reason: wantsScene ? null : 'scene-json' } : null;
  $('inspectScene').hidden = !sceneCheck;
  const image = $('backgroundImage'), video = $('backgroundVideo');
  video.onerror = null; video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  image.hidden = false; image.style.filter = item.tone || ''; video.style.filter = '';
  image.onerror = null;
  const showPreview = () => {
    image.onerror = () => { image.onerror = null; image.src = 'landscape.svg'; };
    image.src = preview || 'landscape.svg';
  };
  if (wallpaperMode() !== 'live' || !renderActive) {
    showPreview();
    $('wallpaperKind').textContent = typeLabel(item);
  } else if (wantsScene) {
    showPreview();
    $('wallpaperKind').textContent = '正在渲染场景…';
    startScene(item, token);
  } else if (wantsLive) {
    showPreview();
    $('wallpaperKind').textContent = '正在启动网页壁纸…';
    if (!silent) toast('正在启动网页壁纸…');
    startLive(item, preview, token, silent).catch(error => {
      if (token !== selectToken) return;
      $('wallpaperKind').textContent = item.type === 'web' ? '网页预览' : '场景预览';
      if (!silent) toast(`${error.message} 已显示预览图。`);
    });
  } else if (item.kind === 'video' && media) {
    showPreview(); video.muted = !wallpaperAudioEnabled(); video.src = media;
    video.onloadeddata = () => { if (token !== selectToken) return; video.hidden = false; image.hidden = true; };
    video.onerror = () => { if (token !== selectToken) return; video.hidden = true; image.hidden = false; showPreview(); $('wallpaperKind').textContent = '视频预览'; if (!silent) toast('浏览器无法播放此视频，已显示预览图。'); };
    video.play().catch(() => { if (token === selectToken) { video.hidden = true; image.hidden = false; if (!silent) toast('视频暂未播放，已保留预览图。'); } });
  } else {
    image.onerror = () => { image.onerror = null; image.src = 'landscape.svg'; if (!silent) toast('原图暂不可读取，已切回内置风景。'); };
    image.src = url;
  }
  currentId = item.id;
  if (remember) preferredWallpaperId = item.id;
  $('currentWallpaper').textContent = item.title; $('currentWallpaper').title = item.title; $('wallpaperKind').textContent = wantsScene ? '正在渲染场景…' : wantsLive ? '正在启动网页壁纸…' : typeLabel(item); persist();
  if ($('libraryDialog').open) renderLibrary();
}
function allWallpapers() { return [...builtins, ...library]; }
function numberOrNull(value) { return Number.isFinite(value) ? value : null; }
function sortedWallpapers(items) {
  const compareTitles = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const valueFor = item => {
    if (sortBy === 'created') return numberOrNull(item.createdAtMs) ?? numberOrNull(item.modifiedAtMs);
    if (sortBy === 'modified') return numberOrNull(item.modifiedAtMs);
    if (sortBy === 'size') return numberOrNull(item.sizeBytes);
    return null;
  };
  return items.sort((a, b) => {
    const aBuiltin = a.type === 'builtin';
    const bBuiltin = b.type === 'builtin';
    if (aBuiltin || bBuiltin) return aBuiltin && bBuiltin ? builtins.findIndex(item => item.id === a.id) - builtins.findIndex(item => item.id === b.id) : aBuiltin ? -1 : 1;
    if (sortBy === 'name') return compareTitles(a, b);
    if (sortBy === 'fileName') return String(a.fileName || a.title).localeCompare(String(b.fileName || b.title), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
    const aValue = valueFor(a);
    const bValue = valueFor(b);
    if (aValue === null || bValue === null) return aValue === bValue ? compareTitles(a, b) : aValue === null ? 1 : -1;
    return bValue - aValue || compareTitles(a, b);
  });
}
function filteredWallpapers(query = '') {
  return sortedWallpapers(allWallpapers().filter(item => {
    if (query && !item.title.toLocaleLowerCase().includes(query)) return false;
    switch (filter) {
      case 'all': return true;
      case 'favorite': return favorites.has(item.id);
      case 'video': return item.kind === 'video';
      case 'preview': return item.kind === 'preview' && !item.live;
      default: return item.type === filter;
    }
  }));
}
function adjacentWallpaper(direction, ...anchors) {
  const pool = filteredWallpapers();
  if (!pool.length) return null;
  for (const anchor of anchors) {
    const index = pool.findIndex(item => item.id === anchor);
    if (index >= 0) return pool[(index + direction + pool.length) % pool.length];
  }
  return direction < 0 ? pool.at(-1) : pool[0];
}
function stepWallpaper(direction) {
  const item = adjacentWallpaper(direction, pendingWallpaperId, currentId);
  if (!item) {
    toast('所选分类没有壁纸。');
  } else if (item.id !== (pendingWallpaperId ?? currentId)) {
    void chooseWallpaper(item);
  }
}
function wallpaperRotationActive() {
  return rotationEnabled && timer.running && focusVisible() && renderActive && !initialSelection && !document.querySelector('dialog[open]');
}
function updateWallpaperRotation() {
  if (!wallpaperRotationActive()) {
    nextRotationAt = null;
    return;
  }
  const now = performance.now();
  nextRotationAt ??= now + WALLPAPER_ROTATION_MS;
  if (now < nextRotationAt) return;
  nextRotationAt = now + WALLPAPER_ROTATION_MS;
  const next = adjacentWallpaper(1, rotationCursor, currentId);
  if (next && next.id !== currentId) void chooseWallpaper(next, { silent: true, rotating: true });
}
async function loadThumbnail(frame, item) {
  const url = await previewOf(item);
  if (!url || !frame.isConnected) return;
  const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy';
  image.style.position = 'absolute'; image.style.inset = '0'; image.style.zIndex = '0';
  if (item.tone) image.style.filter = item.tone;
  image.onload = () => frame.querySelector('.placeholder-icon')?.remove();
  image.onerror = () => image.remove(); frame.prepend(image); image.src = url;
}
function renderLibrary() {
  const matches = filteredWallpapers($('search').value.trim().toLocaleLowerCase());
  $('libraryGrid').replaceChildren(); $('drawerCount').textContent = `${matches.length.toLocaleString()} 张`; $('loadMore').hidden = matches.length <= pageSize;
  $('emptyState').hidden = matches.length > 0;
  if (matches.length === 0) { const noLibrary = !library.length && !$('search').value && filter === 'all'; $('emptyState').querySelector('h3').textContent = noLibrary ? '把喜欢的风景带进来' : '暂时没有匹配的风景'; $('emptyState').querySelector('p').textContent = filter === 'favorite' ? '点击壁纸右上角的爱心，把喜欢的风景收在这里。' : '试试其他关键词，或连接你的本地壁纸文件夹。'; }
  matches.slice(0, pageSize).forEach(item => {
    const card = document.createElement('div'); card.className = `wallpaper-card${item.id === currentId ? ' selected' : ''}`;
    const select = document.createElement('button'); select.className = 'wallpaper-select'; select.title = item.title; select.setAttribute('aria-label', `选择 ${item.title}`); select.onclick = () => { chooseWallpaper(item); $('libraryDialog').close(); };
    const frame = document.createElement('div'); frame.className = 'card-image'; frame._wallpaper = item;
    const placeholder = document.createElement('span'); placeholder.className = 'placeholder-icon'; placeholder.append(createWorkbenchIcon(item.kind === 'video' ? 'play' : 'image')); frame.append(placeholder);
    const badge = document.createElement('span'); badge.className = 'card-badge'; badge.textContent = typeLabel(item); frame.append(badge);
    if (item.id === currentId) { const check = document.createElement('span'); check.className = 'selected-check'; check.append(createWorkbenchIcon('check')); frame.append(check); }
    const name = document.createElement('span'); name.className = 'card-title'; name.textContent = item.title;
    const kind = document.createElement('span'); kind.className = 'card-type'; kind.textContent = item.live ? '本地实时渲染' : item.kind === 'preview' ? '仅使用预览图' : item.kind === 'video' ? '循环播放' : '静态背景';
    select.append(frame, name, kind); card.append(select);
    const favorite = favorites.has(item.id);
    const heart = document.createElement('button');
    heart.className = favorite ? 'favorite-button active' : 'favorite-button';
    heart.append(createWorkbenchIcon('heart'));
    heart.setAttribute('aria-label', `${favorite ? '取消收藏' : '收藏'} ${item.title}`);
    heart.setAttribute('aria-pressed', String(favorite));
    heart.onclick = () => { if (favorites.has(item.id)) favorites.delete(item.id); else favorites.add(item.id); persist(); renderLibrary(); };
    card.append(heart); $('libraryGrid').append(card); loadThumbnail(frame, item);
  });
}
async function setLibrary(items) {
  library = items.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string');
  $('connectionText').textContent = library.length ? `${library.length.toLocaleString()} 张本地壁纸` : '添加本地壁纸';
  $('libraryStatus').classList.toggle('connected', library.length > 0);
  $('libraryCount').textContent = library.length.toLocaleString();
  if (initialSelection && !requestedWallpaperApplied && requestedWallpaperId) {
    requestedWallpaperApplied = true;
    const requested = allWallpapers().find(item => item.id === requestedWallpaperId);
    if (requested) await chooseWallpaper(requested, { silent: true });
    else toast(`找不到指定壁纸：${requestedWallpaperId}`);
  } else if (initialSelection && saved.wallpaperId) {
    const found = allWallpapers().find(item => item.id === saved.wallpaperId);
    if (found) await chooseWallpaper(found, { silent: true });
    else if (saved.wallpaperId !== builtins[0].id) toast('上次的壁纸暂不可用，已显示内置背景。');
  } else if (!allWallpapers().some(item => item.id === currentId)) {
    await chooseWallpaper(builtins[0], { silent: true, remember: false });
  }
  initialSelection = false;
  if ($('libraryDialog').open) renderLibrary();
}
async function connectFolder() {
  await updateLibrary(async () => {
    if (!(await desktop.pickFolder())) return false;
    return true;
  });
}
async function updateLibrary(change = async () => true) {
  if (busy) return;
  busy = true;
  for (const id of ['pickFolder', 'emptyPick', 'refreshLibrary']) $(id).disabled = true;
  try {
    if (!(await change())) return;
    $('sourceLabel').textContent = '正在读取本地目录…';
    await Promise.all([refreshFolders(), refreshWallpapers()]);
    $('sourceLabel').textContent = '本地壁纸目录';
  } catch {
    $('sourceLabel').textContent = '壁纸库读取失败';
    toast('无法读取壁纸库，请检查目录后刷新。');
  } finally {
    busy = false;
    for (const id of ['pickFolder', 'emptyPick', 'refreshLibrary']) $(id).disabled = false;
  }
}
async function refreshWallpapers() {
  const local = await loadLocalLibrary();
  if (!local) throw new Error('Unable to read desktop wallpaper library');
  desktopLibrary = local.items;
  $('libraryHint').textContent = local.warnings[0] || '兼容的场景和网页壁纸会实时播放。渲染失败时显示预览图或内置背景。';
  await setLibrary([...desktopLibrary, ...importedMedia]);
}
async function refreshFolders() {
  const folders = await desktop.listFolders();
  const list = $('folderList');
  list.replaceChildren();
  $('folderManager').hidden = folders.length === 0;
  for (const { folder, available, reason } of folders) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = available ? folder : `${folder}（不可用${reason ? '：' + reason : ''}）`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除文件夹 ${folder}`);
    remove.onclick = () => updateLibrary(async () => { await desktop.removeFolder(folder); return true; });
    row.append(label, remove);
    list.append(row);
  }
  if (folders.some(item => !item.available)) $('folderManager').open = true;
}
function openLibrary() { $('libraryDialog').showModal(); renderLibrary(); }
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('无法切换全屏。'); }
}
function toggleZen() { const active = document.body.classList.toggle('zen-mode'); $('exitZen').hidden = !active; }
$('start').onclick = toggleTimer;
$('reset').onclick = () => { timer.reset(); persist(); renderTimer(); };
$('sound').onclick = () => { soundEnabled = !soundEnabled; updateSound(); if (soundEnabled) initAudio(); persist(); };
$('wallpaperRotation').onclick = () => {
  rotationEnabled = !rotationEnabled;
  rotationCursor = null;
  nextRotationAt = null;
  renderWallpaperControls();
  if (rotationEnabled) {
    updateWallpaperRotation();
    toast(`番茄钟运行时每分钟轮播「${wallpaperCategoryLabel()}」。分类和顺序可在壁纸库设置。`);
  }
  persist();
};
$('wallpaperSound').onclick = () => {
  wallpaperSoundEnabled = !wallpaperSoundEnabled;
  renderWallpaperControls();
  applyWallpaperSound();
  persist();
};
$('settingsButton').onclick = $('customTime').onclick = $('titleButton').onclick = openSettings;
$('durationMode').onclick = () => setMode('duration'); $('deadlineMode').onclick = () => setMode('deadline'); $('applySettings').onclick = applySettings;
$('dimInput').oninput = () => { dim = Number($('dimInput').value); updateDim(); persist(); };
$('soundSetting').onchange = () => { soundEnabled = $('soundSetting').checked; updateSound(); persist(); };
document.querySelectorAll('[data-minutes]').forEach(button => button.onclick = () => { timer.setDuration(Number(button.dataset.minutes) * 60000); persist(); renderTimer(); });
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('wallpaperButton').onclick = $('libraryStatus').onclick = $('currentWallpaper').onclick = openLibrary;
$('inspectScene').onclick = inspectCurrentScene;
let sceneReportTimer;
$('sceneDiagnosticsDialog').addEventListener('close', event => {
  if (!event.currentTarget.open) clearInterval(sceneReportTimer);
});
$('pickFolder').onclick = $('emptyPick').onclick = connectFolder;
$('refreshLibrary').onclick = () => updateLibrary(async () => { await desktop.refreshLibrary(); return true; });
$('pickFiles').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => {
  const items = fromFiles($('fileInput').files);
  if (items.length) {
    importedMedia.push(...items);
    void setLibrary([...desktopLibrary, ...importedMedia]);
    toast(`已临时添加 ${items.length} 个背景。添加文件夹可长期保留。`);
  }
  $('fileInput').value = '';
};
$('search').oninput = () => { pageSize = 32; renderLibrary(); };
if ($('wallpaperSort')) {
  $('wallpaperSort').value = sortBy;
  $('wallpaperSort').onchange = () => {
    sortBy = SORT_OPTIONS.has($('wallpaperSort').value) ? $('wallpaperSort').value : 'created';
    rotationCursor = null;
    nextRotationAt = null;
    pageSize = 32;
    persist();
    renderLibrary();
  };
}
const categoryButtons = document.querySelectorAll('[data-filter]');
function renderWallpaperCategory() {
  categoryButtons.forEach(button => {
    const active = filter === button.dataset.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
categoryButtons.forEach(button => button.onclick = () => {
  filter = button.dataset.filter;
  rotationCursor = null;
  nextRotationAt = null;
  pageSize = 32;
  renderWallpaperCategory();
  renderWallpaperControls();
  renderLibrary();
  persist();
});
$('loadMore').onclick = () => { pageSize += 32; renderLibrary(); };
$('prevWallpaper').onclick = () => stepWallpaper(-1);
$('nextWallpaper').onclick = () => stepWallpaper(1);
$('random').onclick = () => { const pool = library.length ? library : builtins; const candidates = pool.filter(item => item.id !== currentId); const item = candidates[Math.floor(Math.random() * candidates.length)]; if (item) chooseWallpaper(item); };
$('fullscreen').onclick = toggleFullscreen; $('zen').onclick = $('exitZen').onclick = toggleZen;
document.addEventListener('keydown', event => {
  if (isStartupActive() || !focusVisible()) return;
  if (event.target.closest('input,textarea,select,[contenteditable=true]') || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.key === 'Escape' && document.body.classList.contains('zen-mode')) { toggleZen(); return; }
  if (document.querySelector('dialog[open]')) return;
  if (event.code === 'Space' && !event.target.closest('#wallpaperRotation, #wallpaperSound, .wallpaper-steps')) { event.preventDefault(); toggleTimer(); }
  if (event.key.toLowerCase() === 'r') $('reset').click();
  if (event.key.toLowerCase() === 'f') toggleFullscreen();
  if (event.key.toLowerCase() === 'h') toggleZen();
  if (event.key.toLowerCase() === 'b') openLibrary();
});
function pauseWallpaperPlayback() {
  selectToken++;
  pendingWallpaperId = null;
  stopScene();
  if (liveSession) void stopLive();
  $('backgroundVideo').pause();
}

function showCurrentWallpaper() {
  if (pendingWallpaperId !== null) return;
  const selected = allWallpapers().find(item => item.id === currentId) ?? builtins[0];
  void chooseWallpaper(selected, { silent: true, remember: false });
}

function syncWallpaperView() {
  wallpaperHost.inert = !focusVisible();
  applyWallpaperSound();
  const mode = wallpaperMode();
  if (mode === previousWallpaperMode) return;
  previousWallpaperMode = mode;

  if (mode !== 'live') pauseWallpaperPlayback();
  if (mode === 'preview' || (mode === 'live' && renderActive)) showCurrentWallpaper();
}

window.addEventListener('stilltime-material-change', syncWallpaperView);
glassMedia.addEventListener('change', syncWallpaperView);
reducedMotion.addEventListener('change', syncWallpaperView);
window.addEventListener('stilltime-view-change', () => {
  syncWallpaperView();
  renderTimer();
});
function setWallpaperActivity(active) {
  if (renderActive === active) return;
  renderActive = active;
  if (!active) {
    nextRotationAt = null;
    pauseWallpaperPlayback();
    const video = $('backgroundVideo');
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
    $('backgroundImage').hidden = false;
    return;
  }
  if (wallpaperMode() === 'live') showCurrentWallpaper();
}
let activityGeneration = 0;
async function refreshWallpaperActivity() {
  const request = ++activityGeneration;
  try {
    const active = await desktop.risk.getRenderActivity();
    if (request === activityGeneration) setWallpaperActivity(active);
  } catch { /* Use the last activity event from the main process. */ }
}
const renderActivityUnsubscribe = desktop.risk.onRenderActivity(active => {
  activityGeneration++;
  setWallpaperActivity(active);
});
window.addEventListener('focus', refreshWallpaperActivity);
document.addEventListener('visibilitychange', refreshWallpaperActivity);
setTimeout(refreshWallpaperActivity, 400);
document.addEventListener('visibilitychange', () => { if (timer.tick()) { chime(); toast('这段专注完成了，休息一下吧。'); } renderTimer(); persist(); });
window.addEventListener('pagehide', () => { persist(); renderActivityUnsubscribe(); stopScene(); if (liveSession) { const session = liveSession.session; liveSession = null; fetch('/api/live/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }), keepalive: true }).catch(() => {}); } });
setInterval(() => { if (timer.tick()) { chime(); toast('这段专注完成了，休息一下吧。'); persist(); } renderTimer(); $('clock').textContent = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }, 250);
setInterval(persist, 5000);
$('titleButton').textContent = title; updateSound(); updateDim(); renderWallpaperCategory(); renderWallpaperControls(); renderTimer();
try {
  await chooseWallpaper(builtins.find(item => item.id === saved.wallpaperId) || builtins[0], { silent: true, remember: false });
  await updateLibrary();
  initialSelection = false;
  $('wallpaperRotation').dataset.ready = 'true';
} finally { markStartupFocusReady(); }
