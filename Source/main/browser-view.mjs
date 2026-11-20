import { BrowserWindow, WebContentsView, session, shell } from 'electron';

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请输入有效的 HTTP(S) 网页地址。');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('请输入完整的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含账号凭据的 HTTP(S) 网页地址。');
  }
  return url.href;
}

/**
 * Save a webpage without fetching its contents. Existing canonical URLs are
 * returned as-is so a new capture never clears their notes or organization.
 */
export async function saveCollectionLink(workbench, value) {
  const url = httpUrl(value);
  const result = await workbench.saveLink({ url, title: '', tags: [], note: '', readLater: false });
  return result.item;
}

export function createArticleBrowser({ win, directory, sendState = () => {} }) {
  if (!(win instanceof BrowserWindow)) throw new TypeError('网页视图需要工作台窗口。');
  const browserSession = session.fromPartition('persist:reversewear-web-collection-v23');
  browserSession.setSpellCheckerEnabled(false);
  browserSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', event => event.preventDefault());

  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  view.setBorderRadius(16);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event, url) => {
    try { httpUrl(url); }
    catch { event.preventDefault(); }
  });
  view.webContents.on('will-redirect', (event, url) => {
    try { httpUrl(url); }
    catch { event.preventDefault(); }
  });

  win.contentView.addChildView(view);
  view.setVisible(false);
  let attached = false;
  let closed = false;
  let lastError;
  let requestedUrl = '';
  let failedUrl = '';
  const currentState = () => ({
    url: failedUrl || view.webContents.getURL(),
    title: view.webContents.getTitle(),
    loading: view.webContents.isLoading(),
    canGoBack: view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward(),
    ...(lastError ? { error: lastError } : {}),
  });
  const publish = () => sendState(currentState());
  view.webContents.on('did-start-loading', () => { lastError = undefined; failedUrl = ''; publish(); });
  for (const event of ['did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) view.webContents.on(event, publish);
  view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      lastError = description || `网页加载失败 (${code})`;
      failedUrl = url || requestedUrl;
      if (attached && !win.isDestroyed()) {
        view.setVisible(false);
        attached = false;
      }
      publish();
    }
  });

  function assertOpen() {
    if (closed || win.isDestroyed() || view.webContents.isDestroyed()) throw new Error('网页视图已关闭。');
  }

  function setBounds(rect) {
    assertOpen();
    const [width, height] = win.getContentSize();
    const x = Number(rect?.x), y = Number(rect?.y), targetWidth = Number(rect?.width), targetHeight = Number(rect?.height);
    if (![x, y, targetWidth, targetHeight].every(Number.isFinite)) throw new Error('网页显示区域无效。');
    const left = Math.max(0, Math.min(width, Math.round(x)));
    const top = Math.max(0, Math.min(height, Math.round(y)));
    const right = Math.max(left, Math.min(width, Math.round(x + targetWidth)));
    const bottom = Math.max(top, Math.min(height, Math.round(y + targetHeight)));
    const visible = right > left && bottom > top;
    view.setBounds({ x: left, y: top, width: right - left, height: bottom - top });
    view.setVisible(visible);
    attached = visible;
    return visible;
  }

  async function navigate(value) {
    assertOpen();
    const url = httpUrl(value);
    requestedUrl = url;
    failedUrl = '';
    lastError = undefined;
    publish();
    await view.webContents.loadURL(url);
    publish();
    return currentState();
  }

  async function openExternal(value = failedUrl || requestedUrl || view.webContents.getURL()) {
    const url = httpUrl(value);
    await shell.openExternal(url);
    return true;
  }

  function hide() {
    if (closed || win.isDestroyed()) return false;
    attached = false;
    view.setVisible(false);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  return {
    view,
    navigate,
    back: () => view.webContents.navigationHistory.canGoBack() && view.webContents.navigationHistory.goBack(),
    forward: () => view.webContents.navigationHistory.canGoForward() && view.webContents.navigationHistory.goForward(),
    reload: () => failedUrl ? navigate(failedUrl) : view.webContents.reload(),
    setBounds,
    hide,
    openExternal,
    state: currentState,
    close,
  };
}
