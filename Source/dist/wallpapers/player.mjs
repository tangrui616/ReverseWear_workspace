const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const canvas = document.getElementById('sceneCanvas');
const verification = document.getElementById('sceneVerification');
let disposed = false;
let failed = false;
let sims = 0;
let steps = 0;
let peakParticles = 0;
const check = new URLSearchParams((parent === window ? location : parent.location).search).get('verify') === '1';
const boundedDetail = value => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, '[链接]').replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[本地资源]').replace(/\\\\[^\r\n]*/g, '[网络资源]').replace(/\s+/g, ' ').trim().slice(0, 180);
};
const notify = (type) => { if (!disposed) parent.postMessage({ type, id }, location.origin); };
const fail = (reason = 'renderer-failed', detail = failureDetail) => {
  if (disposed || failed) return;
  failed = true;
  canvas.dataset.status = 'error';
  canvas.dataset.failure = reason;
  if (!disposed) parent.postMessage({ type: 'stilltime-scene-error', id, reason, detail: boundedDetail(detail) }, location.origin);
};

async function loadWasm() {
  const module = await import('./static/we_scene_wasm.js');
  await module.default({ module_or_path: new URL('./static/we_scene_wasm_bg.wasm', import.meta.url) });
  const { CpuParticleSim } = module;
  canvas.dataset.wasm = 'ready';
  if (!check) return module;
  // Count calls at the actual wasm-bindgen instance boundary in verification mode.
  return { CpuParticleSim: { new(...args) {
    const sim = CpuParticleSim.new(...args);
    sims++;
    const update = sim.update.bind(sim);
    sim.update = dt => { update(dt); steps++; peakParticles = Math.max(peakParticles, sim.particle_count()); };
    return sim;
  } } };
}

const sceneModule = await import('./static/stilltime-three-renderer.mjs').catch(() => null);
if (!sceneModule) {
  fail('renderer-failed', '此候选版本未附带实时场景渲染组件。');
} else {
  await startScene(sceneModule);
}

async function startScene({ createThreeSceneRenderer, createRenderHealthStore, threeRevision }) {
  canvas.dataset.threeRevision = threeRevision;
  const renderer = createThreeSceneRenderer({ loadWasm, healthStore: createRenderHealthStore({ storage: null }) });
  renderer.setSoundEnabled(params.get('sound') === '1');
  window.addEventListener('message', event => {
    if (disposed || event.source !== parent || event.origin !== location.origin ||
        event.data?.type !== 'stilltime-wallpaper-sound' || typeof event.data.enabled !== 'boolean') return;
    renderer.setSoundEnabled(event.data.enabled);
  });
  renderer.setMediaIntegration(false);
  renderer.setOnContextLost(() => fail('webgl-context-lost'));
  let assembled = false;
  let frameDrawn = false;
  let ready = false;
  let failureReason;
  let failureDetail;
  renderer.setOnHealth(health => {
    if (health?.ok && health.timing?.firstFrameMs >= 0) {
      frameDrawn = true;
      signalReady();
    }
    if (health && !health.ok) {
      failureReason = health.failure?.kind;
      failureDetail = health.failure?.detail;
    }
  });
  function signalReady() {
    if (!assembled || !frameDrawn || ready || disposed || failed) return;
    ready = true;
    canvas.dataset.status = 'ready';
    notify('stilltime-scene-ready');
    if (check) void verifyMotion().catch(error => { verification.textContent = String(error); });
  }
  async function verifyMotion() {
    const samples = [];
    for (let index = 0; index < 3; index++) {
      if (disposed || failed) return;
      const png = await renderer.captureFrame();
      if (!png) throw new Error('Unable to read WebGL frame');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', png)), n => n.toString(16).padStart(2, '0')).join('');
      samples.push(hash);
      if (index < 2) await new Promise(resolve => setTimeout(resolve, 480));
    }
    verification.textContent = JSON.stringify({ id, threeRevision, width: canvas.width, height: canvas.height, wasm: canvas.dataset.wasm, sims, steps, peakParticles, uniqueFrames: new Set(samples).size, frameHashes: samples });
  }

  document.addEventListener('visibilitychange', () => {
    if (disposed) return;
    renderer.setPaused(document.hidden);
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    renderer.dispose();
  }, { once: true });

  try {
    canvas.dataset.status = 'loading';
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) fail('invalid-id');
    else {
      const loaded = await renderer.render(id, canvas, canvas);
      if (disposed) renderer.dispose();
      else if (!loaded) fail(failureReason);
      else {
        assembled = true;
        signalReady();
      }
    }
  } catch (error) {
    console.error('场景播放器无法启动', error);
    fail('exception', error instanceof Error ? error.message : String(error));
  }
}
