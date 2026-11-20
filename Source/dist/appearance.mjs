const desktop = window.stilltimeDesktop;
const root = document.documentElement;
const system = matchMedia('(prefers-color-scheme: dark)');
const trigger = document.getElementById('wb-appearance');
const panel = document.getElementById('wb-appearance-panel');
const status = document.getElementById('wb-appearance-status');
const modeButtons = [...panel.querySelectorAll('[data-mode-choice]')];
const paletteButtons = [...panel.querySelectorAll('[data-palette-choice]')];
const materialKey = 'ui_material';
const materialButtons = panel.querySelectorAll('[data-material-choice]');
const blurKey = 'ui_material_blur';
const blurControl = document.getElementById('wb-glass-blur-control');
const blurSlider = document.getElementById('wb-glass-blur');
const blurValue = document.getElementById('wb-glass-blur-value');
let appearance = { mode: 'system', palette: 'mist' };
let pending = Promise.resolve();
let change = 0;
let materialFrame;

function syncWindowMaterial() {
  cancelAnimationFrame(materialFrame);
  materialFrame = requestAnimationFrame(() => {
    void desktop.syncWindowMaterial({ material: root.dataset.material, glassBlur: Number(blurSlider.value) })
      .catch(error => console.warn('ReverseWear window material:', error));
  });
}

function renderAppearance() {
  const { mode, palette } = appearance;
  root.dataset.theme = mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
  root.dataset.palette = palette;
  modeButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.modeChoice === mode));
  paletteButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.paletteChoice === palette));
  document.querySelector('meta[name="theme-color"]').content = root.dataset.theme === 'dark' ? '#121620' : '#edf0f5';
}

function readMaterial() {
  try {
    return localStorage.getItem(materialKey) === 'glass' ? 'glass' : 'solid';
  } catch {
    return 'solid';
  }
}

function applyMaterial(material) {
  root.dataset.material = material;
  syncWindowMaterial();
  blurControl.hidden = material !== 'glass';
  for (const button of materialButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.materialChoice === material));
  }
}

function readBlur() {
  const fallback = Number(blurSlider.defaultValue);
  try {
    const stored = localStorage.getItem(blurKey);
    if (stored === null || !/^\d+$/.test(stored)) return fallback;
    const radius = Number(stored);
    return radius >= Number(blurSlider.min) && radius <= Number(blurSlider.max) ? radius : fallback;
  } catch {
    return fallback;
  }
}

function renderBlur() {
  const radius = blurSlider.value;
  root.style.setProperty('--glass-blur-radius', `${radius}px`);
  blurValue.value = `${radius} px`;
  blurSlider.setAttribute('aria-valuetext', `${radius} 像素`);
  syncWindowMaterial();
}

function report(message) {
  status.textContent = message;
  status.hidden = !message;
}

function select(update) {
  appearance = { ...appearance, ...update };
  const requested = appearance;
  const revision = ++change;
  renderAppearance();
  report('');
  pending = pending.then(async () => {
    if (change !== revision) return;
    try {
      await desktop.saveAppearance(requested);
    } catch (error) {
      if (change === revision) report('无法保存外观设置。' + (error?.message ? ' ' + error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : ''));
    }
  });
}

function setPanel(open, restoreFocus = false) {
  panel.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (restoreFocus) trigger.focus();
}

trigger.addEventListener('click', event => {
  setPanel(panel.hidden);
  if (!panel.hidden && event.detail === 0) panel.querySelector('[data-mode-choice][aria-pressed="true"]')?.focus();
});
for (const button of modeButtons) {
  button.addEventListener('click', () => select({ mode: button.dataset.modeChoice }));
}
for (const button of paletteButtons) {
  button.addEventListener('click', () => select({ palette: button.dataset.paletteChoice }));
}
for (const button of materialButtons) {
  button.addEventListener('click', () => {
    const material = button.dataset.materialChoice;
    if (material !== root.dataset.material) {
      applyMaterial(material);
      window.dispatchEvent(new Event('stilltime-material-change'));
    }
    try {
      localStorage.setItem(materialKey, material);
      report('');
    } catch {
      report('材质已切换，本次选择无法保存。');
    }
  });
}
blurSlider.addEventListener('input', renderBlur);
blurSlider.addEventListener('change', () => {
  try {
    localStorage.setItem(blurKey, blurSlider.value);
    report('');
  } catch {
    report('模糊强度已调整，本次选择无法保存。');
  }
});
document.addEventListener('pointerdown', event => {
  if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) setPanel(false);
});
document.addEventListener('focusin', event => {
  if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) setPanel(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || panel.hidden) return;
  event.preventDefault();
  setPanel(false, true);
});
system.addEventListener('change', renderAppearance);

applyMaterial(readMaterial());
blurSlider.value = String(readBlur());
renderBlur();
renderAppearance();
try {
  const saved = await desktop.loadAppearance();
  if (saved && !change) {
    appearance = saved;
    renderAppearance();
  }
} catch (error) {
  console.warn('ReverseWear appearance:', error);
}
