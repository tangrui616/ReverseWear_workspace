import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.atlas': 'text/plain; charset=utf-8', '.avif': 'image/avif', '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8', '.dat': 'application/octet-stream', '.gif': 'image/gif',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ktx': 'application/octet-stream', '.ktx2': 'application/octet-stream',
  '.m4a': 'audio/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.mkv': 'video/x-matroska', '.model3': 'application/json',
  '.moc3': 'application/octet-stream', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
  '.otf': 'font/otf', '.png': 'image/png', '.skel': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf', '.vtt': 'text/vtt', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8', '.basis': 'application/octet-stream',
  '.webm': 'video/webm', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const MAX_BODY_BYTES = 4096;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

function responseHeaders(contentType, { csp, ranges = false, size } = {}) {
  const headers = new Headers({
    'cache-control': 'no-store, private',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  if (csp) headers.set('content-security-policy', csp);
  if (ranges) headers.set('accept-ranges', 'bytes');
  if (Number.isSafeInteger(size)) headers.set('content-length', String(size));
  return headers;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(size - 1, end) };
}

async function fileResponse(file, { method = 'GET', rangeHeader, root, csp, ranges = false } = {}) {
  try {
    const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!within(actualRoot, actualFile)) return new Response(null, { status: 404 });
    const extension = path.extname(actualFile).toLowerCase();
    const contentType = MIME[extension];
    if (!contentType || !(await stat(actualFile)).isFile()) return new Response(null, { status: 404 });
    const info = await stat(actualFile);
    const headers = responseHeaders(contentType, { csp, ranges, size: info.size });
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    if (ranges && rangeHeader) {
      const range = parseRange(rangeHeader, info.size);
      if (!range) {
        headers.set('content-range', `bytes */${info.size}`);
        headers.set('content-length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
      headers.set('content-length', String(range.end - range.start + 1));
      return new Response(Readable.toWeb(createReadStream(actualFile, { start: range.start, end: range.end })), { status: 206, headers });
    }
    return new Response(Readable.toWeb(createReadStream(actualFile)), { status: 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

async function requestJson(request) {
  if (request.headers.get('content-type') !== 'application/json') return null;
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function wallpaperShim(session, metadata, parentOrigin, soundEnabled) {
  const values = Object.fromEntries(Object.entries(metadata.general?.properties ?? {})
    .filter(([, property]) => property && typeof property === 'object')
    .map(([key, property]) => [key, { value: property.value }]));
  const safeValues = JSON.stringify(values).replace(/</g, '\\u003c');
  return `<script>
(()=>{
  const session=${JSON.stringify(session)}, target=${JSON.stringify(parentOrigin)}, properties=${safeValues};
  let enabled=${soundEnabled === true};
  const notify=(type,error)=>parent.postMessage({type,session,error},target);
  const mediaState=new WeakMap(), mediaEvents=new WeakSet(), activeMedia=new Set(), masterGains=new WeakMap(), activeGains=new Set();
  const mediaDescriptor=name=>Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,name);
  const mutedDescriptor=mediaDescriptor('muted'), volumeDescriptor=mediaDescriptor('volume');
  const setMediaState=(media,state)=>{
    mediaState.set(media,state);
    mutedDescriptor.set.call(media,state.muted||!enabled);
    volumeDescriptor.set.call(media,enabled?state.volume:0);
  };
  for(const [name,descriptor] of [['muted',mutedDescriptor],['volume',volumeDescriptor]]){
    Object.defineProperty(HTMLMediaElement.prototype,name,{
      configurable:true,
      enumerable:descriptor.enumerable,
      get(){const state=mediaState.get(this);return state?state[name]:descriptor.get.call(this)},
      set(value){
        const state=mediaState.get(this)||{muted:mutedDescriptor.get.call(this),volume:volumeDescriptor.get.call(this)};
        state[name]=name==='muted'?Boolean(value):Math.max(0,Math.min(1,Number(value)||0));
        setMediaState(this,state);
      }
    });
  }
  const originalPlay=HTMLMediaElement.prototype.play;
  const observePlayback=media=>{
    if(mediaEvents.has(media))return;
    mediaEvents.add(media);
    for(const eventName of ['pause','ended','emptied'])media.addEventListener(eventName,()=>activeMedia.delete(media));
  };
  HTMLMediaElement.prototype.play=function(...args){
    const state=mediaState.get(this)||{muted:mutedDescriptor.get.call(this),volume:volumeDescriptor.get.call(this)};
    setMediaState(this,state);
    observePlayback(this);
    let result;
    try{result=originalPlay.apply(this,args)}catch(error){activeMedia.delete(this);throw error}
    if(result&&typeof result.then==='function')result.then(()=>{if(!this.paused&&!this.ended)activeMedia.add(this);else activeMedia.delete(this)},()=>activeMedia.delete(this));
    else if(!this.paused&&!this.ended)activeMedia.add(this);
    return result;
  };
  const setEnabled=value=>{
    enabled=value;
    const mediaToUpdate=new Set([...activeMedia,...document.querySelectorAll('audio,video')]);
    for(const media of mediaToUpdate){
      const state=mediaState.get(media)||{muted:mutedDescriptor.get.call(media),volume:volumeDescriptor.get.call(media)};
      setMediaState(media,state);
    }
    for(const gain of activeGains){
      const context=gain.context;
      if(context.state==='closed'){
        activeGains.delete(gain);
        masterGains.delete(context);
      }else gain.gain.setValueAtTime(enabled?1:0,context.currentTime);
    }
  };
  addEventListener('message',event=>{
    const message=event.data;
    if(event.origin!==target||event.source!==parent||message?.type!=='stilltime-wallpaper-sound'||message.session!==session||typeof message.enabled!=='boolean')return;
    setEnabled(message.enabled);
  });
  if(window.AudioNode){
    const connect=AudioNode.prototype.connect;
    const disconnect=AudioNode.prototype.disconnect;
    AudioNode.prototype.connect=function(destination,...args){
      if(this.context&&destination===this.context.destination){
        const context=this.context;
        let gain=masterGains.get(context);
        if(!gain){
          gain=context.createGain();
          gain.gain.setValueAtTime(enabled?1:0,context.currentTime);
          masterGains.set(context,gain);
          activeGains.add(gain);
          context.addEventListener('statechange',()=>{
            if(context.state==='closed'){
              activeGains.delete(gain);
              masterGains.delete(context);
            }
          });
          connect.call(gain,destination);
        }
        if(this!==gain)return connect.call(this,gain,...args);
      }
      return connect.call(this,destination,...args);
    };
    AudioNode.prototype.disconnect=function(destination,...args){
      const context=this.context, gain=context&&masterGains.get(context);
      if(arguments.length&&gain&&destination===context.destination)return disconnect.call(this,gain,...args);
      return arguments.length?disconnect.call(this,destination,...args):disconnect.call(this);
    };
  }
  const observeMedia=media=>{
    const state=mediaState.get(media)||{muted:mutedDescriptor.get.call(media),volume:volumeDescriptor.get.call(media)};
    setMediaState(media,state);
    observePlayback(media);
  };
  const observer=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='attributes'&&record.target instanceof HTMLMediaElement)observeMedia(record.target);
      for(const node of record.addedNodes){
        if(node instanceof HTMLMediaElement)observeMedia(node);
        node.querySelectorAll?.('audio,video').forEach(observeMedia);
      }
    }
  });
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['muted','volume']});
  let listener;
  const apply=()=>{
    try{listener?.applyGeneralProperties?.({fps:60,schemecolor:'0 0 0'});listener?.applyUserProperties?.(properties);listener?.setPaused?.(false)}
    catch(error){console.warn('Wallpaper properties:',error)}
  };
  Object.defineProperty(window,'wallpaperPropertyListener',{configurable:true,get:()=>listener,set:value=>{listener=value;queueMicrotask(apply)}});
  window.wallpaperRegisterAudioListener=callback=>{if(typeof callback==='function')setInterval(()=>callback(Array(128).fill(0)),1000/30)};
  ['wallpaperRegisterMediaPropertiesListener','wallpaperRegisterMediaPlaybackListener','wallpaperRegisterMediaTimelineListener','wallpaperRegisterMediaThumbnailListener'].forEach(name=>window[name]=()=>{});
  window.wallpaperPluginListener={onPluginLoaded:()=>{}};
  addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('audio,video').forEach(observeMedia);apply();notify('stilltime-web-ready')});
  addEventListener('error',event=>{if(event.message)console.warn('Wallpaper:',event.message)});
})();
</script>`;
}

function secureEntry(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || relativePath.includes('\\')) return null;
  const segments = relativePath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  const candidate = path.resolve(root, ...segments);
  if (!within(root, candidate) || path.basename(candidate).toLowerCase() === 'project.json') return null;
  return candidate;
}

export function createDesktopWebRenderer({
  getItem,
  parentOrigin = 'https://stilltime-app.invalid',
  webOrigin = 'https://stilltime-wallpaper.invalid',
  width = 1920,
  height = 1080,
  fps = 60,
} = {}) {
  if (typeof getItem !== 'function') throw new TypeError('getItem must be a function');
  const expectedParent = new URL(parentOrigin).origin;
  const expectedWeb = new URL(webOrigin).origin;
  let current = null;

  async function start(request) {
    const payload = await requestJson(request);
    if (!payload || typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(payload.id) || (payload.soundEnabled !== undefined && typeof payload.soundEnabled !== 'boolean')) return json({ error: '请求无效' }, 400);
    const record = await getItem(payload.id);
    if (!record || record.type !== 'web' || !record.file || !record.projectRoot || !record.scanRoot) return json({ error: '仅支持已安装的网页壁纸' }, 404);
    try {
      const [trustedRoot, root, entry] = await Promise.all([realpath(record.scanRoot), realpath(record.projectRoot), realpath(record.file)]);
      if (!within(trustedRoot, root) || !within(root, entry) || !['.html', '.htm'].includes(path.extname(entry).toLowerCase())) return json({ error: '网页入口不受支持' }, 400);
      const metadataPath = await realpath(path.join(root, 'project.json'));
      if (!within(root, metadataPath) || !(await stat(metadataPath)).isFile()) return json({ error: '壁纸设置文件不可用' }, 400);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return json({ error: '壁纸设置文件不可用' }, 400);
      const session = randomUUID();
      current = { session, id: payload.id, root, entry, metadata, soundEnabled: payload.soundEnabled === true, ready: false };
      const relative = path.relative(root, entry).split(path.sep).map(encodeURIComponent).join('/');
      return json({ session, mode: 'web', frameUrl: `${webOrigin}/${session}/${relative}`, width, height, fps });
    } catch {
      return json({ error: '网页壁纸文件不可用' }, 404);
    }
  }

  async function webAsset(request, url) {
    if (!current || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: current ? 405 : 404 });
    if (request.headers.get('origin') && request.headers.get('origin') !== expectedWeb) return new Response(null, { status: 403 });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
    const hadTrailingSlash = pathname.endsWith('/');
    let relativePath = pathname.replace(/^\/+/, '');
    const firstSlash = relativePath.indexOf('/');
    const first = firstSlash < 0 ? relativePath : relativePath.slice(0, firstSlash);
    if (first === current.session) relativePath = firstSlash < 0 ? '' : relativePath.slice(firstSlash + 1);
    else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(first)) return new Response(null, { status: 404 });
    if (!relativePath) relativePath = path.relative(current.root, current.entry).split(path.sep).join('/');
    else if (hadTrailingSlash) relativePath += 'index.html';
    const file = secureEntry(current.root, relativePath);
    if (!file) return new Response(null, { status: 404 });
    const extension = path.extname(file).toLowerCase();
    if (!MIME[extension]) return new Response(null, { status: 404 });
    const csp = `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${expectedParent}`;
    const response = await fileResponse(file, { method: request.method, root: current.root, rangeHeader: request.headers.get('range'), ranges: ['.mp4', '.webm', '.mkv', '.mov'].includes(extension), csp });
    if (response.status !== 200 || !['.html', '.htm'].includes(extension)) return response;
    let body;
    try { body = await response.text(); } catch { return new Response(null, { status: 404 }); }
    const bootstrap = wallpaperShim(current.session, current.metadata, expectedParent, current.soundEnabled);
    const html = /<head(?:\s[^>]*)?>/i.test(body)
      ? body.replace(/<head(?:\s[^>]*)?>/i, (head) => head + bootstrap)
      : bootstrap + body;
    if (request.method === 'GET') current.ready = true;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(request.method === 'HEAD' ? null : html, { status: response.status, headers });
  }

  return async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    if (url.origin === expectedParent) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': expectedParent, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (request.headers.get('origin') && request.headers.get('origin') !== expectedParent) return json({ error: '来源不受支持' }, 403);
      if (url.pathname === '/api/live/start' && request.method === 'POST') return start(request);
      if (url.pathname === '/api/live/stop' && request.method === 'POST') {
        const payload = await requestJson(request);
        if (!payload || typeof payload.session !== 'string' || payload.session.length > 64) return json({ error: '请求无效' }, 400);
        if (current && payload.session === current.session) current = null;
        return json({ active: Boolean(current) });
      }
      if (url.pathname === '/api/live/status' && request.method === 'GET') {
        return json(current
          ? { active: true, session: current.session, id: current.id, type: 'web', mode: 'web', frames: current.ready ? 1 : 0, width, height, fps, error: null }
          : { active: false, session: null, frames: 0, error: null });
      }
      return json({ error: '接口不存在' }, 404);
    }
    if (url.origin === expectedWeb) return webAsset(request, url);
    return new Response(null, { status: 403 });
  };
}
