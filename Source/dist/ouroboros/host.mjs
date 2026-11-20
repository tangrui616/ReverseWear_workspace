const parentOrigin = 'https://stilltime-app.invalid';
const scene = document.getElementById('ouroboros');
let night = new URLSearchParams(location.search).has('night');
let themePoll;

function sceneUrl() {
  const url = new URL('/Ouroboros_Infinite_Loop_V9.html', location.origin);
  if (night) url.searchParams.set('night', '');
  return url;
}

function applyTheme() {
  const ouro = scene.contentWindow?.__ouro;
  if (typeof ouro?.setNight !== 'function') return false;
  if (ouro.S.night !== night) {
    const paused = scene.contentDocument?.body.classList.contains('still');
    ouro.setNight(night);
    // V9 blends the new lighting on animation frames.
    if (paused) ouro.startRun();
  }
  return true;
}

function applyThemeWhenReady() {
  clearInterval(themePoll);
  let attempts = 0;
  themePoll = setInterval(() => {
    attempts += 1;
    try {
      if (applyTheme()) {
        clearInterval(themePoll);
      } else if (attempts >= 240) {
        clearInterval(themePoll);
        console.warn('ReverseWear Ouroboros scene did not expose its theme control.');
      }
    } catch (error) {
      clearInterval(themePoll);
      console.error('ReverseWear Ouroboros theme sync failed:', error);
    }
  }, 50);
}

scene.addEventListener('load', applyThemeWhenReady);
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'stilltime-theme') return;
  if (event.data.theme !== 'dark' && event.data.theme !== 'light') return;
  night = event.data.theme === 'dark';
  try {
    if (!applyTheme()) applyThemeWhenReady();
  } catch {
    applyThemeWhenReady();
  }
});
scene.src = sceneUrl().href;
