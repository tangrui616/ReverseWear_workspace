const api = window.stilltimeCapture;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let appearance = 'system';
function applyAppearance() {
  document.documentElement.dataset.theme = appearance === 'system' ? (systemTheme.matches ? 'dark' : 'light') : appearance;
}
api.onAppearance(mode => { appearance = mode; applyAppearance(); });
systemTheme.addEventListener('change', applyAppearance);
applyAppearance();
document.querySelector('#capture-close').onclick = () => void api.close();
const form = document.querySelector('#capture-form');
const input = document.querySelector('#capture-text');
const sourceWrap = document.querySelector('#capture-source-wrap');
const sourceText = document.querySelector('#capture-source');
const status = document.querySelector('#capture-status');
const submit = document.querySelector('#capture-submit');
let source = '';
let saving = false;

function updateSource(value) {
  source = value;
  sourceText.textContent = value;
  sourceWrap.hidden = !value;
}

api.onSource(value => updateSource(typeof value === 'string' ? value : ''));
document.querySelector('#capture-source-remove').addEventListener('click', () => updateSource(''));
input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || saving) return;
  event.preventDefault();
  form.requestSubmit();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  if (!input.value.trim()) {
    status.textContent = '先写下一句话。';
    status.dataset.error = 'true';
    input.focus();
    return;
  }
  saving = true;
  submit.disabled = true;
  status.textContent = '正在保存…';
  delete status.dataset.error;
  try {
    await api.save({ text: input.value, ...(source ? { source } : {}) });
    await api.close();
  } catch (error) {
    status.textContent = error.message || '保存失败，请重试。';
    status.dataset.error = 'true';
    saving = false;
    submit.disabled = false;
    input.focus();
  }
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void api.close();
  }
});
window.addEventListener('load', () => requestAnimationFrame(() => input.focus()), { once: true });
