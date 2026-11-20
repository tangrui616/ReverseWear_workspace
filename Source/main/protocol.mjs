import { session } from 'electron';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderImportedDocument } from '../desktop_document.mjs';
import { createDesktopResources } from '../desktop_resources.mjs';
import { createDesktopWebRenderer } from '../desktop_web.mjs';

import { APP, WEB, OUROBOROS, OUROBOROS_SCENE } from './origins.mjs';
export { APP, WEB, OUROBOROS } from './origins.mjs';

export function originFor(url) {
  try { return new URL(url).origin; }
  catch { return ''; }
}

export function setupDesktopProtocol({ directory, DATA, workbench, articles, getLibrary, getItem, steamRoot, sceneDiagnostics }) {
  const respond = createDesktopResources({
    staticDirectory: path.join(directory, 'dist'), getLibrary, getItem, steamRoot,
    getPdfPath: id => workbench.getPdfPath(id), pdfDirectory: path.join(DATA, 'Documents', 'Files'),
    getInspirationImage: id => workbench.getFilePath(id),
  });
  const ouroborosDirectory = path.join(directory, 'dist', 'ouroboros');
  const ouroborosFiles = new Map([
    ['/host.html', 'text/html; charset=utf-8'],
    ['/host.mjs', 'text/javascript; charset=utf-8'],
    [OUROBOROS_SCENE, 'text/html; charset=utf-8'],
  ]);
  const ouroborosPolicies = new Map([
    ['/host.html', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${OUROBOROS}; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${APP}`],
    [OUROBOROS_SCENE, "default-src 'none'; script-src 'sha256-5SCCiqZQvOEoeawEe+JYQDcDj+DPdmNdXu2D91g/h58=' 'sha256-jFZ1HdzrfrUJ6CEN/uQKbM2Dl4t0a+h31m2vLzK1r6E='; style-src 'unsafe-inline'; img-src data: blob:; media-src 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + APP + ' ' + OUROBOROS],
  ]);
  const respondOuroboros = async request => {
    const url = new URL(request.url);
    const mime = ouroborosFiles.get(url.pathname);
    if (!mime || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const file = path.join(ouroborosDirectory, path.basename(url.pathname));
    const content = await readFile(file);
    const headers = new Headers({
      'cache-control': 'no-store',
      'content-length': String(content.byteLength),
      'content-type': mime,
      'x-content-type-options': 'nosniff',
    });
    const policy = ouroborosPolicies.get(url.pathname);
    if (policy) headers.set('content-security-policy', policy);
    return new Response(request.method === 'HEAD' ? null : content, { headers });
  };
  const respondWeb = createDesktopWebRenderer({ getItem, parentOrigin: APP, webOrigin: WEB });
  const captureAssets = new Map([
    ['/capture.html', ['capture.html', 'text/html; charset=utf-8']],
    ['/capture.css', ['capture.css', 'text/css; charset=utf-8']],
    ['/capture.mjs', ['capture.mjs', 'text/javascript; charset=utf-8']],
  ]);
  const respondCapture = async request => {
    const url = new URL(request.url);
    const asset = captureAssets.get(url.pathname);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const body = await readFile(path.join(directory, 'dist', asset[0]));
    const headers = new Headers({
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': asset[1],
      'x-content-type-options': 'nosniff',
    });
    if (url.pathname === '/capture.html') headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  };
  const desktop = session.fromPartition('persist:stilltime-v6', { cache: true });
  desktop.setSpellCheckerEnabled(false);
  desktop.setPermissionRequestHandler((_sender, _permission, answer) => answer(false));
  desktop.setPermissionCheckHandler(() => false);
  desktop.on('will-download', event => event.preventDefault());
  desktop.webRequest.onBeforeRequest((details, answer) => {
    const { url } = details;
    answer({ cancel: ![APP, WEB, OUROBOROS].includes(originFor(url)) && !/^(data:|blob:|about:blank$)/.test(url) });
  });
  desktop.protocol.handle('https', async request => {
    const url = new URL(request.url);
    const source = request.initiatorOrigin || request.headers.get('origin') || originFor(request.referrer);
    if (url.origin === OUROBOROS) {
      if ((!source || source === APP || source === OUROBOROS) && ['GET', 'HEAD'].includes(request.method)) {
        try { return await respondOuroboros(request); }
        catch { return new Response(null, { status: 404 }); }
      }
      return new Response(null, { status: 403 });
    }
    if (url.origin === WEB && (!source || source === APP || source === WEB)) return respondWeb(request);
    if (url.origin !== APP || (source && source !== APP) ||
        (!source && (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)))) {
      return new Response(null, { status: 403 });
    }
    try {
      if (captureAssets.has(url.pathname)) return await respondCapture(request);
      const articleAsset = /^\/api\/articles\/([a-f0-9-]{36})\/(cover|icon)$/i.exec(url.pathname);
      if (articleAsset) {
        if (!articles || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
        const asset = await articles.assetPath(articleAsset[1], articleAsset[2]);
        if (!asset) return new Response(null, { status: 404 });
        const assetFile = typeof asset === 'string' ? asset : asset.path;
        const info = await lstat(assetFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 ** 2) return new Response(null, { status: 404 });
        return new Response(request.method === 'GET' ? await readFile(assetFile) : null, { headers: {
          'content-type': asset.mime || 'application/octet-stream', 'cache-control': 'private, max-age=60',
          'x-content-type-options': 'nosniff',
        } });
      }
      if (url.pathname === '/api/workbench/document-render') {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        try {
          const input = await request.text();
          if (input.length > 1024) throw new Error('文档请求无效。');
          const file = await workbench.getDocument(JSON.parse(input).fileId);
          return Response.json({ html: await renderImportedDocument(file.name, file.contents) },
            { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json({ error: error.message || '文档读取失败。' }, { status: 400 });
        }
      }
      if (url.pathname === '/wallpapers/player.html') sceneDiagnostics.begin(url.searchParams.get('id'));
      const response = await (url.pathname.startsWith('/api/live/') ? respondWeb(request) : respond(request));
      sceneDiagnostics.record(url, response.status);
      return response;
    } catch (error) {
      sceneDiagnostics.record(url, 500);
      console.error('反穿衣工作台资源读取：', error.message);
      return Response.json({ error: '本地资源读取失败。' }, { status: 500 });
    }
  });
  return desktop;
}
