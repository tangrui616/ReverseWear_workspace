import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_ROOT = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || process.cwd(), '.local', 'share'), 'ReverseWear');
const wallpaperCategories = new Set(['all', 'video', 'scene', 'web', 'preview', 'favorite']);
const sortModes = new Set(['created', 'modified', 'size', 'name', 'fileName']);
const appearanceModes = new Set(['system', 'light', 'dark']);
const palettes = new Set(['mist', 'ocean', 'sage', 'plum', 'sand']);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

function cleanAppearance(value) {
  return {
    mode: appearanceModes.has(value?.mode) ? value.mode : 'system',
    palette: palettes.has(value?.palette) ? value.palette : 'mist',
  };
}

function writeSettings(file, value) {
  const pending = file + '.pending';
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(pending, file);
}

function cleanStartupIdentity(value) {
  const text = (key, fallback, length) => {
    const input = value?.[key];
    return typeof input === 'string' ? Array.from(input.trim()).slice(0, length).join('') || fallback : fallback;
  };
  return {
    identity: text('identity', '反穿衣', 24),
    identityId: text('identityId', 'RW-0001', 80),
    accessLevel: text('accessLevel', '研究员 · 3', 80),
  };
}

function cleanState(value = {}) {
  const timer = {};
  for (const key of ['total', 'remaining', 'deadline', 'endAt']) {
    if (Number.isFinite(value.timer?.[key])) timer[key] = value.timer[key];
  }
  timer.mode = value.timer?.mode === 'deadline' ? 'deadline' : 'duration';
  timer.running = value.timer?.running === true;
  timer.completed = value.timer?.completed === true;
  return {
    timer,
    startupIdentity: cleanStartupIdentity(value.startupIdentity),
    title: typeof value.title === 'string' ? value.title.slice(0, 48) : '',
    sound: value.sound !== false,
    wallpaperSound: value.wallpaperSound === true,
    wallpaperRotation: value.wallpaperRotation === true,
    wallpaperCategory: wallpaperCategories.has(value.wallpaperCategory) ? value.wallpaperCategory : 'all',
    dim: Number.isFinite(value.dim) ? Math.max(0, Math.min(80, value.dim)) : 35,
    favorites: Array.isArray(value.favorites) ? [...new Set(value.favorites.filter(isId))].slice(0, 10000) : [],
    wallpaperId: isId(value.wallpaperId) ? value.wallpaperId : null,
    sortBy: sortModes.has(value.sortBy) ? value.sortBy : 'created',
  };
}

export function openDesktopSettings(root = DEFAULT_ROOT) {
  const settingsDirectory = path.resolve(root, 'Settings', 'Stilltime');
  const runtimeDirectory = path.resolve(root, 'Runtime', 'Stilltime');
  const profileDirectory = path.join(runtimeDirectory, 'Chromium');
  const file = path.join(settingsDirectory, 'settings.json');
  const appearanceFile = path.join(settingsDirectory, 'appearance.json');
  const riskFile = path.join(settingsDirectory, 'risk-preferences.json');
  let settings = { schemaVersion: VERSION, folders: [], state: cleanState() };
  let appearance = cleanAppearance();
  try {
    for (const directory of [settingsDirectory, profileDirectory]) mkdirSync(directory, { recursive: true });
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.schemaVersion !== VERSION) throw new Error('此版本无法读取该配置格式');
      settings = {
        schemaVersion: VERSION,
        folders: Array.isArray(data.folders) ? data.folders.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)) : [],
        state: cleanState(data.state ?? {}),
      };
    }
    // Check writability before opening the window even when no settings have changed.
    writeFileSync(path.join(settingsDirectory, '.write-check'), '', 'utf8');
    writeFileSync(path.join(runtimeDirectory, '.write-check'), '', 'utf8');
  } catch (error) {
    throw new Error(`无法使用 ${settingsDirectory} 或 ${runtimeDirectory}。\n${error.message}`, { cause: error });
  }

  try {
    if (existsSync(appearanceFile)) appearance = cleanAppearance(JSON.parse(readFileSync(appearanceFile, 'utf8')));
  } catch (error) {
    console.warn('Stilltime appearance:', error.message);
  }

  function commit(next) {
    if (JSON.stringify(next) === JSON.stringify(settings) && existsSync(file)) return;
    writeSettings(file, next);
    settings = next;
  }
  commit(settings);
  let risk = cleanRiskPreferences(existsSync(riskFile) ? JSON.parse(readFileSync(riskFile, 'utf8')) : {});
  return {
    settingsDirectory,
    runtimeDirectory,
    profileDirectory,
    getState: () => settings.state,
    getAppearance: () => appearance,
    saveAppearance: value => {
      const next = cleanAppearance(value);
      writeSettings(appearanceFile, next);
      appearance = next;
      return appearance;
    },
    getFolders: () => [...settings.folders],
    getRiskPreferences: () => ({ ...risk }),
    saveRiskPreferences: value => {
      const next = cleanRiskPreferences({ ...risk, ...value });
      writeSettings(riskFile, next);
      risk = next;
      return { ...risk };
    },
    saveState(value) {
      const state = value ?? {};
      // Identity is updated independently of the focus timer's periodic saves.
      const next = Object.hasOwn(state, 'startupIdentity') && Object.keys(state).length === 1
        ? { ...settings.state, startupIdentity: state.startupIdentity }
        : { startupIdentity: settings.state.startupIdentity, ...state };
      commit({ ...settings, state: cleanState(next) });
    },
    saveFolders: folders => commit({ ...settings, folders }),
  };
}

function cleanRiskPreferences(value) {
  return {
    dayStartMinutes: Number.isInteger(value.dayStartMinutes) && value.dayStartMinutes >= 0 && value.dayStartMinutes < 1440 ? value.dayStartMinutes : 0,
    lowPower: value.lowPower === true,
    showOuroboros: value.showOuroboros !== false,
    warnActionLimit: value.warnActionLimit !== false,
    backupDirectory: typeof value.backupDirectory === 'string' && path.isAbsolute(value.backupDirectory) ? value.backupDirectory : null,
    captureShortcut: typeof value.captureShortcut === 'string' && /^[A-Za-z][A-Za-z0-9+]{0,63}$/.test(value.captureShortcut)
      ? value.captureShortcut : 'Control+Alt+I',
  };
}

// Future migrations call this before replacing a settings file.
export function backupDesktopSettings(file, sourceVersion) {
  copyFileSync(file, `${file}.v${sourceVersion}.bak`);
}
