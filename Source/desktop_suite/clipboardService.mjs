import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_CLIPBOARD_BLOB = 16 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT = 1024 * 1024;
const MAX_PENDING_CAPTURES = 16;
const MAX_SELF_WRITE_SEQUENCES = 64;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const API_CREDENTIAL = /\b(?:api[_ -]?key|access[_ -]?token|token|client[_ -]?secret|secret|password|passwd|signature)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=%~-]{12,}/i;
const SECRET_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/;
const URL_ONLY = /^https?:\/\/[^\s<>"']+$/i;
const COLOR_ONLY = /^(?:#[\da-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;
const RTF_SKIP_DESTINATIONS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'listtable', 'listoverridetable', 'xmlopen', 'datastore', 'themedata', 'generator', 'filetbl', 'revtbl']);

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function isSensitive(values) {
  return values.some(value => {
    if (typeof value !== 'string') return false;
    const candidates = [value];
    try { candidates.push(decodeURIComponent(value.replaceAll('+', ' '))); } catch { /* Preserve malformed input for direct checks. */ }
    return candidates.some(candidate => PRIVATE_KEY.test(candidate) || JWT.test(candidate) ||
      API_CREDENTIAL.test(candidate) || SECRET_PREFIX.test(candidate));
  });
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>|<\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/[\t ]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}

function rtfToText(rtf) {
  const input = String(rtf ?? '').slice(0, MAX_CLIPBOARD_TEXT);
  const output = [];
  const groups = [{ skip: false, unicodeFallback: 1, codePage: 1252 }];
  let fallbackCharacters = 0;
  let outputLength = 0;
  const append = value => {
    if (groups.at(-1).skip) return;
    if (fallbackCharacters > 0) {
      fallbackCharacters--;
      return;
    }
    output.push(value);
    outputLength += value.length;
  };

  for (let index = 0; index < input.length && outputLength < MAX_CLIPBOARD_TEXT; index++) {
    const character = input[index];
    if (character === '{') {
      groups.push({ ...groups.at(-1) });
      continue;
    }
    if (character === '}') {
      if (groups.length > 1) groups.pop();
      continue;
    }
    if (character !== '\\') {
      if (character !== '\n' && character !== '\r') append(character);
      continue;
    }

    const next = input[index + 1];
    if (next === undefined) break;
    if (next === '\\' || next === '{' || next === '}') {
      append(next);
      index++;
      continue;
    }
    if (next === "'") {
      const hex = input.slice(index + 2, index + 4);
      if (/^[\da-f]{2}$/i.test(hex)) {
        const codePage = groups.at(-1).codePage;
        const encoding = codePage === 65001 ? 'utf-8' : `windows-${codePage}`;
        try { append(new TextDecoder(encoding).decode(Uint8Array.of(Number.parseInt(hex, 16)))); }
        catch { append(new TextDecoder('windows-1252').decode(Uint8Array.of(Number.parseInt(hex, 16)))); }
        index += 3;
      } else index++;
      continue;
    }
    if (!/[a-z]/i.test(next)) {
      if (next === '*') groups.at(-1).skip = true;
      else if (next === '~') append('\u00a0');
      else if (next === '_') append('\u2011');
      index++;
      continue;
    }

    let end = index + 1;
    while (end < input.length && /[a-z]/i.test(input[end])) end++;
    const word = input.slice(index + 1, end).toLowerCase();
    let numberEnd = end;
    if (input[numberEnd] === '-') numberEnd++;
    while (numberEnd < input.length && /\d/.test(input[numberEnd])) numberEnd++;
    const argument = numberEnd > end ? Number(input.slice(end, numberEnd)) : null;
    const delimiter = input[numberEnd] === ' ' ? numberEnd + 1 : numberEnd;
    index = delimiter - 1;

    if (groups.at(-1).skip) continue;
    if (RTF_SKIP_DESTINATIONS.has(word)) {
      groups.at(-1).skip = true;
      continue;
    }
    if (word === 'uc' && argument != null) {
      groups.at(-1).unicodeFallback = Math.max(0, Math.min(argument, 8));
      continue;
    }
    if (word === 'ansicpg' && argument != null) {
      groups.at(-1).codePage = argument;
      continue;
    }
    if (word === 'u' && argument != null) {
      append(String.fromCharCode(argument < 0 ? argument + 65536 : argument));
      fallbackCharacters = groups.at(-1).unicodeFallback;
      continue;
    }
    if (word === 'par' || word === 'line') append('\n');
    else if (word === 'tab') append('\t');
    else if (word === 'emdash') append('\u2014');
    else if (word === 'endash') append('\u2013');
    else if (word === 'bullet') append('\u2022');
    else if (word === 'lquote') append('\u2018');
    else if (word === 'rquote') append('\u2019');
    else if (word === 'ldblquote') append('\u201c');
    else if (word === 'rdblquote') append('\u201d');
  }
  return output.join('');
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function ownerFor(snapshot) {
  const ownerProcess = snapshot?.owner?.processName || snapshot?.owner?.executable || '';
  const foregroundProcess = snapshot?.foreground?.processName || snapshot?.foreground?.executable || '';
  const processName = path.basename(ownerProcess);
  const name = snapshot?.owner?.name || processName || '';
  return {
    name: String(name || processName || '').slice(0, 200),
    process: String(processName || '').toLowerCase().slice(0, 260),
    foregroundProcess: String(path.basename(foregroundProcess) || '').toLowerCase().slice(0, 260),
  };
}

async function readClipboardSnapshot(clipboard, bridge, sequence) {
  let items;
  let lastError;
  for (const delay of [0, 100, 150, 250]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (sequence != null) {
      let current;
      try { current = await bridge.request('snapshot'); }
      catch { return { stale: true }; }
      if (current?.sequence !== sequence || current.privacyExcluded) return { stale: true };
    }
    try {
      items = await clipboard.read();
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (items === undefined) throw lastError ?? new Error('无法读取剪贴板。');
  if (!Array.isArray(items) || items.length === 0) return null;
  const item = items[0];
  const types = new Set(item.types.map(type => String(type).toLowerCase()));
  const values = new Map();
  let totalTextBytes = 0;
  for (const type of ['text/plain', 'text/html', 'text/rtf', 'image/png']) {
    if (!types.has(type)) continue;
    const value = await item.getType(type);
    const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8')
      : Number.isFinite(value?.size) ? value.size
        : bytes(value)?.length;
    if (!Number.isFinite(size)) continue;
    if (type === 'image/png') {
      if (size > MAX_CLIPBOARD_BLOB) return { rejected: '剪贴板图片超过 16 MiB。' };
    } else {
      totalTextBytes += size;
      if (totalTextBytes > MAX_CLIPBOARD_TEXT) return { rejected: '剪贴板富文本合计超过 1 MiB。' };
    }
    values.set(type, value);
  }

  async function decode(type) {
    const value = values.get(type);
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (type === 'image/png') {
      return bytes(value) ?? (typeof value?.arrayBuffer === 'function'
        ? Buffer.from(await value.arrayBuffer()) : null);
    }
    if (typeof value?.text === 'function') return value.text();
    return bytes(value)?.toString('utf8');
  }
  return {
    text: await decode('text/plain'),
    html: await decode('text/html'),
    rtf: await decode('text/rtf'),
    imageBuffer: await decode('image/png'),
  };
}

function normalizeClipboardPayload(raw, snapshot) {
  const files = Array.isArray(snapshot.files) ? snapshot.files.filter(file => typeof file === 'string') : [];
  if (files.length) return { type: 'files', files };
  if (!raw) return null;
  const imageBuffer = bytes(raw.imageBuffer);
  if (imageBuffer?.length) {
    if (imageBuffer.length > MAX_CLIPBOARD_BLOB) return { rejected: '剪贴板图片超过 16 MiB。' };
    const dimensions = pngSize(imageBuffer);
    if (!dimensions || dimensions.width * dimensions.height > 32_000_000) return { rejected: '剪贴板图片格式无效或尺寸超过 32 MP。' };
    return { type: 'image', imageBuffer, imageWidth: dimensions.width, imageHeight: dimensions.height };
  }
  if (raw.rejected) return raw;
  const text = String(raw.text ?? '').replace(/\0/g, '');
  const html = String(raw.html ?? '').replace(/\0/g, '');
  const rtf = String(raw.rtf ?? '').replace(/\0/g, '');
  if (![text, html, rtf].some(Boolean)) return null;
  if ([text, html, rtf].some(value => Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_TEXT)) {
    return { rejected: '剪贴板文本超过 1 MiB。' };
  }
  const plainText = text || htmlToText(html) || rtfToText(rtf);
  const normalizedForType = plainText.trim();
  if (URL_ONLY.test(normalizedForType)) return { type: 'link', text: plainText, html, rtf };
  if (COLOR_ONLY.test(normalizedForType)) return { type: 'color', text: plainText, html, rtf };
  if (html) return { type: 'html', text: plainText, html, rtf };
  if (rtf) return { type: 'rtf', text: plainText, html, rtf };
  return { type: 'text', text: plainText };
}

function contentFingerprint(item) {
  let content;
  if (item.type === 'image') content = bytes(item.imageBuffer);
  else if (item.type === 'files') content = [...new Set(item.files.map(file => path.resolve(file)))].sort().join('\n');
  else if (item.type === 'html' || item.type === 'rtf') {
    const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
    content = JSON.stringify({ text: normalize(item.text), html: normalize(item.html), rtf: normalize(item.rtf) });
  } else content = String(item.text ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
  return createHash('sha256').update(item.type === 'image' ? content : `${item.type}\0${content}`).digest('hex');
}

export function createClipboardService({ store, clipboard, ClipboardItemClass, bridge, onChanged = () => {}, onStateChanged = () => {}, onNotice = () => {} }) {
  if (!store || !clipboard || !bridge) throw new TypeError('剪贴板服务需要 store、clipboard 和 Windows bridge。');
  let listening = false;
  let unsubscribe = null;
  let capturing = Promise.resolve();
  const pendingCaptures = new Set();
  let selectionCopyActive = false;
  const selectionCopyEvents = [];
  let restoredClipboardSequence = null;
  const selfWriteSequences = new Map();
  let pendingSelfWriteHash = '';
  let pendingSelfWriteUntil = 0;

  function state() {
    const preferences = store.getSettings();
    const stats = store.getStats();
    const items = store.listStack();
    return {
      enabled: preferences.captureEnabled,
      length: items.length,
      items,
      captureEnabled: preferences.captureEnabled,
      autoPaste: preferences.autoPaste,
      stackEnabled: preferences.stackEnabled,
      count: stats.count,
      boards: store.listBoards(),
    };
  }

  function expireSelfWrites(now = Date.now()) {
    for (const [sequence, expiresAt] of selfWriteSequences) {
      if (expiresAt <= now) selfWriteSequences.delete(sequence);
    }
    if (pendingSelfWriteUntil <= now) {
      pendingSelfWriteHash = '';
      pendingSelfWriteUntil = 0;
    }
  }

  function rememberSelfWriteSequence(sequence) {
    if (sequence == null) return;
    selfWriteSequences.set(sequence, Date.now() + 2500);
    while (selfWriteSequences.size > MAX_SELF_WRITE_SEQUENCES) {
      selfWriteSequences.delete(selfWriteSequences.keys().next().value);
    }
  }

  async function registerSelfWrite(sequenceBefore, expectedHash) {
    if (sequenceBefore == null) return;
    try {
      const current = await bridge.request('snapshot');
      if (current?.sequence == null || current.sequence === sequenceBefore) return;
      const raw = Array.isArray(current.files) && current.files.length
        ? null : await readClipboardSnapshot(clipboard, bridge, current.sequence);
      if (raw?.stale) return;
      const content = normalizeClipboardPayload(raw, current);
      if (!content || content.rejected || contentFingerprint(content) !== expectedHash) return;
      const confirmed = await bridge.request('snapshot');
      if (confirmed?.sequence === current.sequence) {
        rememberSelfWriteSequence(current.sequence);
        return current.sequence;
      }
    } catch { /* A sequence is registered only after its clipboard content is confirmed. */ }
    finally {
      pendingSelfWriteHash = '';
      pendingSelfWriteUntil = 0;
    }
  }

  async function capture(snapshot) {
    const preferences = store.getSettings();
    if (!preferences.captureEnabled || !snapshot || snapshot.privacyExcluded || snapshot.helperWrite) return { ignored: true };
    const source = ownerFor(snapshot);
    const ignored = preferences.excludedProcesses ?? preferences.ignoredProcesses;
    if (!source.process) return { ignored: true, reason: 'unknown-source' };
    if (!source.foregroundProcess || ignored.includes(source.process) ||
        ignored.includes(source.foregroundProcess)) return { ignored: true, reason: 'excluded-process' };
    expireSelfWrites();
    if (snapshot.sequence != null && selfWriteSequences.has(snapshot.sequence)) {
      return { ignored: true, reason: 'self-write-sequence' };
    }

    const raw = Array.isArray(snapshot.files) && snapshot.files.length
      ? null : await readClipboardSnapshot(clipboard, bridge, snapshot.sequence);
    if (raw?.stale) return { ignored: true, reason: 'clipboard-changed' };
    if (snapshot.sequence != null) {
      let current;
      try { current = await bridge.request('snapshot'); }
      catch { return { ignored: true, reason: 'sequence-unavailable' }; }
      if (current?.sequence !== snapshot.sequence) return { ignored: true, reason: 'clipboard-changed' };
      if (current.privacyExcluded || current.helperWrite) return { ignored: true, reason: 'clipboard-private-or-self-write' };
    }
    const content = normalizeClipboardPayload(raw, snapshot);
    if (!content) return { ignored: true };
    if (content.rejected) {
      onNotice(content.rejected);
      return { ignored: true, reason: 'too-large-or-invalid' };
    }
    const checked = [content.text, content.html, content.rtf, ...(content.files ?? [])].filter(Boolean);
    if (isSensitive(checked)) return { ignored: true, reason: 'sensitive' };

    if (snapshot.sequence != null && Date.now() < pendingSelfWriteUntil &&
        contentFingerprint(content) === pendingSelfWriteHash) {
      rememberSelfWriteSequence(snapshot.sequence);
      return { ignored: true, reason: 'self-write' };
    }

    if (content.type === 'files') {
      const uniqueFiles = [...new Set(content.files.map(file => path.resolve(file)))];
      if (uniqueFiles.length > 256) return { ignored: true, reason: 'too-many-files' };
      content.files = uniqueFiles;
    }
    const saved = await store.addItem({ ...content, source, capturedAt: new Date() });
    if (preferences.stackEnabled) store.enqueueStack(saved.item);
    onChanged({ type: saved.duplicate ? 'updated' : 'added', item: saved.item });
    onStateChanged(state());
    return saved;
  }

  function receive(snapshot) {
    if (!listening) return;
    if (selectionCopyActive) {
      if (snapshot?.sequence != null && selectionCopyEvents.length < MAX_PENDING_CAPTURES) {
        selectionCopyEvents.push(snapshot.sequence);
      }
      return;
    }
    const key = snapshot?.sequence ?? Symbol('clipboard-event');
    if (pendingCaptures.has(key) || pendingCaptures.size >= MAX_PENDING_CAPTURES) return;
    pendingCaptures.add(key);
    capturing = capturing.then(() => capture(snapshot)).catch(error => {
      onNotice(`剪贴板读取失败：${error.message}`);
      return { ignored: true, reason: 'capture-failed' };
    }).finally(() => pendingCaptures.delete(key));
  }

  async function start() {
    if (listening) return state();
    listening = true;
    unsubscribe = bridge.onEvent(snapshot => receive(snapshot));
    onStateChanged(state());
    return state();
  }

  async function stop() {
    listening = false;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    await capturing;
    return state();
  }

  async function writeItem(item, plainText = false) {
    if (item.type === 'files') {
      if (plainText) throw new Error('文件列表没有纯文本粘贴格式。');
      await bridge.request('setFiles', { paths: item.content.files });
    } else if (item.type === 'image') {
      if (plainText) throw new Error('图片没有纯文本粘贴格式。');
      if (!ClipboardItemClass) throw new Error('Electron ClipboardItem 尚未接入。');
      const imagePath = store.itemImagePath(item.id);
      if (!imagePath) throw new Error('剪贴板图片文件已不可用。');
      const imageBytes = await (await import('node:fs/promises')).readFile(imagePath);
      const blob = new Blob([imageBytes], { type: 'image/png' });
      await clipboard.write([new ClipboardItemClass({ 'image/png': blob })]);
    } else if (plainText || (item.type === 'text' && !item.content.html && !item.content.rtf) ||
        ((item.type === 'link' || item.type === 'color') && !item.content.html && !item.content.rtf)) {
      await clipboard.writeText(item.content.text);
    } else {
      if (!ClipboardItemClass) throw new Error('Electron ClipboardItem 尚未接入。');
      const payload = {};
      if (item.content.text) payload['text/plain'] = new Blob([item.content.text], { type: 'text/plain' });
      if (item.content.html) payload['text/html'] = new Blob([item.content.html], { type: 'text/html' });
      if (item.content.rtf) payload['text/rtf'] = new Blob([item.content.rtf], { type: 'text/rtf' });
      await clipboard.write([new ClipboardItemClass(payload)]);
    }
  }

  async function paste(id, { plainText = false, foreground, allowedCurrentHwnd, beforeSend } = {}) {
    const item = store.getItem(id);
    if (!item) throw new Error('剪贴板记录不存在。');
    if (plainText && (item.type === 'files' || item.type === 'image')) {
      return { written: false, pasted: false, reason: 'plain-text-unavailable', item };
    }
    let beforeWrite;
    try { beforeWrite = await bridge.request('snapshot'); } catch { beforeWrite = null; }
    const target = foreground === undefined ? beforeWrite?.foreground : foreground;
    const payload = { type: item.type, text: item.content.text, html: item.content.html,
      rtf: item.content.rtf, files: item.content.files };
    if (item.type === 'image') {
      const imagePath = store.itemImagePath(item.id);
      if (!imagePath) throw new Error('剪贴板图片文件已不可用。');
      const imageBytes = await (await import('node:fs/promises')).readFile(imagePath);
      payload.imageBuffer = imageBytes;
    }
    const writePayload = plainText ? normalizeClipboardPayload({ text: payload.text }, {}) : payload;
    const expectedHash = contentFingerprint(writePayload || payload);
    pendingSelfWriteHash = expectedHash;
    pendingSelfWriteUntil = Date.now() + 2500;
    await writeItem(item, plainText);
    const sequence = await registerSelfWrite(beforeWrite?.sequence, expectedHash);
    const expected = { foregroundHwnd: target?.hwnd ?? null, pid: target?.pid ?? null, sequence };
    if (!expected.foregroundHwnd || !expected.pid) {
      return { written: true, pasted: false, reason: 'no-target', item };
    }
    let focusResult;
    try {
      focusResult = await bridge.request('focus', {
        foregroundHwnd: expected.foregroundHwnd,
        pid: expected.pid,
        allowedCurrentHwnd: Number.isSafeInteger(allowedCurrentHwnd) ? allowedCurrentHwnd : 0,
      });
    } catch { focusResult = null; }
    try { if (beforeSend) await beforeSend(); }
    catch { return { written: true, pasted: false, reason: 'hide-failed', item }; }
    if (!store.getSettings().autoPaste) {
      return { written: true, pasted: false, reason: focusResult?.ok ? 'manual-paste' : 'focus-changed', item };
    }
    if (expected.sequence == null) return { written: true, pasted: false, reason: 'clipboard-unconfirmed', item };
    try {
      await new Promise(resolve => setTimeout(resolve, 65));
      const result = await bridge.request('paste', {
        foregroundHwnd: expected.foregroundHwnd,
        pid: expected.pid,
        sequence: expected.sequence,
      });
      return { written: true, pasted: Boolean(result?.ok),
        reason: result?.ok ? undefined : 'paste-refused', item };
    } catch {
      return { written: true, pasted: false, reason: 'paste-failed', item };
    }
  }

  async function pasteNext({ foreground, allowedCurrentHwnd, beforeSend } = {}) {
    const next = store.peekStack();
    if (!next) return { written: false, empty: true };
    const result = await paste(next.item_id, { foreground, allowedCurrentHwnd, beforeSend });
    if (result.written) store.popStack();
    onStateChanged(state());
    return result;
  }

  async function setCaptureEnabled(enabled) {
    const preferences = await store.updateSettings({ captureEnabled: Boolean(enabled) });
    if (preferences.captureEnabled) await start();
    else await stop();
    return state();
  }

  async function setStackEnabled(enabled) {
    const preferences = await store.updateSettings({ stackEnabled: Boolean(enabled) });
    onStateChanged(state());
    return preferences.stackEnabled;
  }

  async function writeText(text) {
    const value = String(text ?? '').slice(0, MAX_CLIPBOARD_TEXT);
    const payload = { type: 'text', text: value };
    let before;
    try { before = await bridge.request('snapshot'); } catch { before = null; }
    const expectedHash = contentFingerprint(payload);
    pendingSelfWriteHash = expectedHash;
    pendingSelfWriteUntil = Date.now() + 2500;
    await clipboard.writeText(value);
    await registerSelfWrite(before?.sequence, expectedHash);
    return { written: true, text: value };
  }

  async function copyToClipboard(id) {
    const item = store.getItem(id);
    if (!item) throw new Error('剪贴板记录不存在。');
    let before;
    try { before = await bridge.request('snapshot'); } catch { before = null; }
    const payload = { type: item.type, text: item.content?.text, html: item.content?.html,
      rtf: item.content?.rtf, files: item.content?.files };
    if (item.type === 'image') {
      const imagePath = store.itemImagePath(item.id);
      if (!imagePath) throw new Error('剪贴板图片文件已不可用。');
      const imageBytes = await (await import('node:fs/promises')).readFile(imagePath);
      payload.imageBuffer = imageBytes;
    }
    const expectedHash = contentFingerprint(payload);
    pendingSelfWriteHash = expectedHash;
    pendingSelfWriteUntil = Date.now() + 2500;
    await writeItem(item, false);
    const sequence = await registerSelfWrite(before?.sequence, expectedHash);
    return { written: true, sequence };
  }

  async function copyBatch(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) throw new Error('请选择 1 到 100 条记录。');
    const items = [...new Set(ids.map(value => String(value)))].map(value => store.getItem(value));
    if (items.some(item => !item)) throw new Error('有剪贴板记录已经不存在，请刷新后重试。');
    const fileCount = items.filter(item => item.type === 'files').length;
    if (fileCount && fileCount !== items.length) throw new Error('文字和文件需要分批复制。');
    if (!fileCount) {
      if (items.some(item => item.type === 'image' || !item.content?.text?.trim())) throw new Error('图片或没有纯文本的记录，请单条复制。');
      const text = items.map(item => item.content.text).join('\n\n');
      if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT) throw new Error('合并后的文字超过 1 MiB，请分批复制。');
      await writeText(text);
      return { written: true, type: 'text', count: items.length };
    }
    const files = items.flatMap(item => item.content?.files ?? []);
    const unique = new Map();
    for (const file of files) {
      const key = process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
      if (!unique.has(key)) unique.set(key, file);
    }
    const paths = [...unique.values()];
    if (paths.length > 256) throw new Error('一次最多复制 256 个文件。');
    if (!paths.length) throw new Error('所选记录中没有可用文件。');
    const before = await bridge.request('snapshot').catch(() => null);
    const expectedHash = contentFingerprint({ type: 'files', files: paths });
    pendingSelfWriteHash = expectedHash;
    pendingSelfWriteUntil = Date.now() + 2500;
    await bridge.request('setFiles', { paths });
    const sequence = await registerSelfWrite(before?.sequence, expectedHash);
    return { written: true, type: 'files', count: paths.length, sequence };
  }

  async function copySelection({ foreground, allowedCurrentHwnd } = {}) {
    let before;
    try { before = await bridge.request('snapshot'); } catch { before = null; }
    const target = foreground === undefined ? before?.foreground : foreground;
    if (!target?.hwnd || !target?.pid) return { ok: false, reason: 'no-target' };
    const preferences = store.getSettings();
    const targetProcess = String(path.basename(target.processName || target.executable || '')).toLowerCase();
    const allowedSnapshot = snapshot => {
      if (!snapshot || snapshot.privacyExcluded ||
          (snapshot.helperWrite && snapshot.sequence !== restoredClipboardSequence)) return false;
      const processName = String(path.basename(snapshot.foreground?.processName || snapshot.foreground?.executable || '')).toLowerCase();
      return processName === targetProcess && !(preferences.excludedProcesses ?? preferences.ignoredProcesses).includes(processName);
    };
    const isSameForeground = snapshot => snapshot?.foreground?.hwnd === target.hwnd && snapshot?.foreground?.pid === target.pid;
    if (!allowedSnapshot(before) || !isSameForeground(before)) return { ok: false, reason: 'foreground-changed' };
    let selected;
    try { selected = await bridge.request('selection'); } catch { selected = null; }
    if (typeof selected?.text === 'string' && selected.text.trim() &&
        (!selected.foreground || (selected.foreground.hwnd === target.hwnd && selected.foreground.pid === target.pid))) {
      let afterSelection;
      try { afterSelection = await bridge.request('snapshot'); } catch { afterSelection = null; }
      if (!allowedSnapshot(afterSelection) || !isSameForeground(afterSelection)) {
        return { ok: false, reason: 'foreground-changed' };
      }
      if (isSensitive([selected.text])) return { ok: false, reason: 'sensitive' };
      return { ok: true, text: selected.text, source: 'accessibility' };
    }
    if (!preferences.selectionCopyFallback || before?.sequence == null) {
      return { ok: false, reason: 'no-selection' };
    }
    let focus;
    try {
      focus = await bridge.request('focus', {
        foregroundHwnd: target.hwnd,
        pid: target.pid,
        allowedCurrentHwnd: Number.isSafeInteger(allowedCurrentHwnd) ? allowedCurrentHwnd : 0,
      });
    } catch { focus = null; }
    if (!focus?.ok) return { ok: false, reason: 'focus-changed' };
    selectionCopyEvents.length = 0;
    selectionCopyActive = true;
    let result;
    let afterCopy;
    try {
      try {
        result = await bridge.request('copy', {
          foregroundHwnd: target.hwnd,
          pid: target.pid,
          sequence: before.sequence,
        });
      } catch { result = null; }
      try { afterCopy = await bridge.request('snapshot'); } catch { afterCopy = null; }
      // A failed restore can leave the transient copied selection on the system clipboard.
      // Do not feed clipboard events from this operation back into history capture.
      for (const sequence of selectionCopyEvents) rememberSelfWriteSequence(sequence);
      if (afterCopy?.sequence != null && afterCopy.sequence !== before.sequence) {
        rememberSelfWriteSequence(afterCopy.sequence);
      }
    } finally {
      selectionCopyEvents.length = 0;
      selectionCopyActive = false;
    }
    const restoredClipboardMatches = result?.clipboardRestored === true &&
      Number.isSafeInteger(result.sequence) && afterCopy?.sequence === result.sequence &&
      afterCopy?.helperWrite === true && afterCopy?.privacyExcluded === false &&
      result.foreground?.hwnd === target.hwnd && result.foreground?.pid === target.pid &&
      isSameForeground(afterCopy) &&
      String(path.basename(afterCopy.foreground?.processName || afterCopy.foreground?.executable || '')).toLowerCase() === targetProcess &&
      !(preferences.excludedProcesses ?? preferences.ignoredProcesses).includes(targetProcess);
    if (result?.ok && restoredClipboardMatches && typeof result.text === 'string' && !isSensitive([result.text])) {
      restoredClipboardSequence = result.sequence;
      rememberSelfWriteSequence(result.sequence);
      return { ok: true, text: result.text, source: 'guarded-copy' };
    }
    return { ok: false, reason: result?.error ?? 'copy-refused' };
  }

  async function openHistory() {
    const snapshot = await bridge.request('snapshot');
    return { snapshot, state: state() };
  }

  return {
    start,
    stop,
    capture,
    getState: state,
    openHistory,
    paste,
    pasteNext,
    setCaptureEnabled,
    setStackEnabled,
    writeText,
    copyToClipboard,
    copyBatch,
    copySelection,
    getClipboard: () => readClipboardSnapshot(clipboard),
  };
}

export { htmlToText, isSensitive, normalizeClipboardPayload, pngSize, rtfToText };
