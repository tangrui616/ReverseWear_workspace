import { sendEvent } from './main/ipc.mjs';

function roundedShape(width, height, radius) {
  const shape = [{ x: 0, y: radius, width, height: height - 2 * radius }];
  for (let y = 0; y < radius; y++) {
    const offset = Math.max(0, Math.round(radius - Math.sqrt(radius ** 2 - (radius - y - .5) ** 2)));
    shape.push({ x: offset, y, width: width - 2 * offset, height: 1 });
    shape.push({ x: offset, y: height - 1 - y, width: width - 2 * offset, height: 1 });
  }
  return shape;
}

export function wireWindowChrome(win, { publish = true } = {}) {
  const state = () => ({ maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  let shapeKey;
  function refresh() {
    if (win.isDestroyed() || win.isMinimized()) return;
    const value = state();
    const [width, height] = win.getSize();
    const flush = value.maximized || value.fullscreen;
    const key = flush ? 'flush' : width + 'x' + height;
    if (process.platform === 'win32' && win.setShape && shapeKey !== key) {
      win.setShape(flush ? [] : roundedShape(width, height, 16));
      shapeKey = key;
    }
    if (publish) sendEvent(win.webContents, 'window:state', value);
  }
  for (const event of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, refresh);
  }
  win.once('ready-to-show', refresh);
  return { state };
}
