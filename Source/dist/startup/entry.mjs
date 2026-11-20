import { getStartupConfig } from './config.mjs';

const desktop = window.stilltimeDesktop;
const query = new URLSearchParams(location.search);
const page = document.documentElement;
let activeRun;

export const initialWorkspaceState = desktop.loadState();
let focusReady, workbenchReady;
const workspaceReady = Promise.all([
  initialWorkspaceState,
  new Promise(resolve => { focusReady = resolve; }),
  new Promise(resolve => { workbenchReady = resolve; }),
]);
workspaceReady.catch(() => {});
export { focusReady as markStartupFocusReady, workbenchReady as markStartupWorkbenchReady };

export function isStartupActive() {
  return Boolean(activeRun);
}

function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, '0')).join('-');
}

function shouldPlay(config) {
  if (!config.enabled || config.mode === 'off') return false;
  if (config.mode === 'daily') {
    try { return localStorage.getItem('stilltime.startup:day') !== today(); }
    catch { /* Start normally if storage cannot be read. */ }
  }
  return true;
}

function notifyActive(active) {
  if (active) page.dataset.startupActive = 'true';
  else delete page.dataset.startupActive;
  window.dispatchEvent(new CustomEvent('stilltime-startup-active', { detail: active }));
}

async function run(config, preview = false) {
  if (activeRun || (!preview && !shouldPlay(config))) return;
  const root = document.querySelector('#st-splash-template').content.firstElementChild.cloneNode(true);
  const canvas = root.querySelector('canvas');
  const inactive = [...document.querySelectorAll('body > .mac-titlebar, body > .app-shell, #workbench')].filter(item => !item.inert);
  const returnFocus = preview ? document.activeElement : null;
  const session = {};
  activeRun = session;
  const previousOverflow = page.style.overflow;
  page.style.overflow = 'hidden';
  for (const item of inactive) item.inert = true;
  document.body.append(root);
  notifyActive(true);
  root.classList.add('booting');
  let shellRestored = false;
  const restoreShell = () => {
    if (shellRestored) return;
    shellRestored = true;
    root.remove();
    for (const item of inactive) item.inert = false;
    page.style.overflow = previousOverflow;
    activeRun = undefined;
    notifyActive(false);
  };

  let controller, stage, probePromise, reason = 'error';
  const stageAbort = new AbortController();
  let stagePromise;
  const probe = () => probePromise ??= desktop.startupProbe().catch(() => ({ ok: false }));
  const onPageHide = () => {
    stageAbort.abort();
    controller?.dispose();
    stage?.dispose();
  };
  window.addEventListener('pagehide', onPageHide, { once: true });
  try {
    const { createStartupController } = await import('./controller.mjs');
    if (config.theme === 'night' || (config.theme === 'follow' &&
      (page.dataset.theme ? page.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches))) {
      root.classList.add('night');
    }
    controller = createStartupController({
      root, config, preview, probe, loadState: () => workspaceReady,
      identity: preview ? config.identity : initialWorkspaceState.then(state => state.startupIdentity),
      onSkip: () => stageAbort.abort(),
      onComplete: outcome => { reason = outcome; restoreShell(); },
    });
    const status = root.querySelector('.st-status');
    const subtitle = root.querySelector('.st-sub');
    status.textContent = '反穿衣工作台';
    subtitle.textContent = 'STILLTIME · REVERSEWEAR';
    controller.startShell();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    root.dataset.uiReadyAtMs = String(Math.round(performance.now()));
    page.dataset.startupUiReadyAtMs = root.dataset.uiReadyAtMs;
    performance.mark('reversewear:ui-ready');
    const appearance = config.theme === 'follow' ? await desktop.loadAppearance().catch(() => null) : null;
    const night = config.theme === 'night' || (config.theme === 'follow' &&
      (appearance?.mode === 'dark' || (appearance?.mode !== 'light' &&
        matchMedia('(prefers-color-scheme: dark)').matches)));
    root.classList.toggle('night', night);
    canvas.addEventListener('webglcontextlost', () => {
      if (root.isConnected) controller.dispose();
    }, { once: true });
    stagePromise = import('./stage.mjs').then(({ createOuroborosStage }) => createOuroborosStage({
      canvas, night, signal: stageAbort.signal,
      onTap: controller.handleTap, onKey: controller.handleKey, onNight: controller.onNight,
    }));
    stage = await stagePromise;
    if (stageAbort.signal.aborted) {
      stage.dispose();
      stage = null;
    } else {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (stageAbort.signal.aborted) {
        stage.dispose();
        stage = null;
      } else {
        controller.attachStage(stage);
        root.classList.remove('booting');
        root.dataset.stageReadyAtMs = String(Math.round(performance.now()));
        page.dataset.startupStageReadyAtMs = root.dataset.stageReadyAtMs;
        performance.mark('reversewear:stage-ready');
        await controller.start();
      }
    }
  } catch (error) {
    if (!stageAbort.signal.aborted) {
      reason = 'unsupported';
      console.warn('反穿衣开屏：', error?.stack ?? error?.message ?? error);
    }
  } finally {
    stageAbort.abort();
    window.removeEventListener('pagehide', onPageHide);
    controller?.dispose();
    stage?.dispose();
    restoreShell();
    returnFocus?.focus({ preventScroll: true });
  }
  if (!preview && probePromise) {
    void probePromise.then(result => {
      if (result.mirror?.changed > 0) {
        window.dispatchEvent(new CustomEvent('stilltime-startup-mirror', { detail: result.mirror.changed }));
      }
    });
  }
  return reason;
}

export function previewStartup(config) {
  return run(config, true);
}

export async function testStartupVoice() {
  throw new Error('此候选版本未附带开屏语音素材。');
}

if (!query.has('verify') || query.get('startup') === '1') {
  void run(getStartupConfig());
}
