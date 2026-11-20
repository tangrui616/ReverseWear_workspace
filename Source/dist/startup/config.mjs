const STORAGE_KEY = 'stilltime.startup:config';

export const STARTUP_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'always',
  theme: 'follow',
  speed: 1,
  flyIn: 8.5,
  requireConfirm: true,
  allowSkip: true,
  glass: true,
  glassOpacity: 0.72,
  glassBlur: 22,
  glassSaturate: 160,
  backdropBlur: 28,
  voice: false,
  voiceVolume: 0.9,
  sfx: true,
  sfxVolume: 0.5,
  voiceCue: true,
});

const ranges = {
  speed: [0.35, 3], flyIn: [4, 14], glassOpacity: [0.15, 0.95],
  glassBlur: [0, 60], glassSaturate: [100, 200], backdropBlur: [0, 80],
  voiceVolume: [0, 1], sfxVolume: [0, 1],
};

function normalize(value = {}) {
  const config = { ...STARTUP_DEFAULTS };
  for (const [key, range] of Object.entries(ranges)) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) config[key] = Math.min(range[1], Math.max(range[0], number));
  }
  for (const key of ['enabled', 'requireConfirm', 'allowSkip', 'glass', 'voice', 'sfx', 'voiceCue']) {
    if (typeof value[key] === 'boolean') config[key] = value[key];
  }
  if (['always', 'daily', 'off'].includes(value.mode)) config.mode = value.mode;
  if (['follow', 'day', 'night'].includes(value.theme)) config.theme = value.theme;
  return config;
}

export function getStartupConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...STARTUP_DEFAULTS };
  }
}

export function saveStartupConfig(patch = {}) {
  const next = normalize({ ...getStartupConfig(), ...patch });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('stilltime-startup-config-change', { detail: next }));
  return next;
}
