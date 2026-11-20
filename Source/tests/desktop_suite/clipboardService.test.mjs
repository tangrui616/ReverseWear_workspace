import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openClipboardStore } from '../../desktop_suite/clipboardStore.mjs';
import { createClipboardService, isSensitive, normalizeClipboardPayload, rtfToText } from '../../desktop_suite/clipboardService.mjs';

test('clipboard service rejects sensitive content and classifies links and colors', () => {
  assert.equal(isSensitive(['authorization: Bearer nope']), false);
  assert.equal(isSensitive(['api_key=0123456789abcdef0123456789']), true);
  assert.equal(isSensitive(['https://example.org/?access%5Ftoken=012345678901234567890123']), true);
  assert.equal(normalizeClipboardPayload({ text: 'https://example.org/paper' }, {}).type, 'link');
  assert.equal(normalizeClipboardPayload({ text: '#4A8' }, {}).type, 'color');
  assert.equal(normalizeClipboardPayload({ text: '  code\n' }, {}).text, '  code\n');
  const richLink = normalizeClipboardPayload({ text: 'https://example.org', html: '<a href="https://example.org">paper</a>' }, {});
  assert.equal(richLink.type, 'link');
  assert.equal(richLink.html, '<a href="https://example.org">paper</a>');
  assert.equal(normalizeClipboardPayload({ rtf: String.raw`{\rtf1\ansi hello\par {\b world} \u20320?}` }, {}).text, 'hello\nworld 你');
  assert.equal(rtfToText(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}} Caf\'e9}`), ' Café');
});

test('clipboard service copies selected text and file records without attempting an automatic paste', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-batch-copy-'));
  const store = await openClipboardStore(directory);
  let clipboardText = '';
  let writtenFiles;
  const requests = [];
  const bridge = {
    onEvent() { return () => {}; },
    async request(command, input = {}) {
      requests.push(command);
      if (command === 'snapshot') return { sequence: 4, foreground: { hwnd: 10, pid: 11 } };
      if (command === 'setFiles') { writtenFiles = input.paths; return true; }
      throw new Error('Unexpected bridge operation: ' + command);
    },
  };
  const clipboard = { async writeText(value) { clipboardText = value; } };
  const service = createClipboardService({ store, clipboard, bridge });
  try {
    const first = await store.addItem({ type: 'text', text: 'first' });
    const second = await store.addItem({ type: 'link', text: 'https://example.org' });
    assert.deepEqual(await service.copyBatch([first.item.id, second.item.id]), { written: true, type: 'text', count: 2 });
    assert.equal(clipboardText, 'first\n\nhttps://example.org');

    const files = await store.addItem({ type: 'files', files: ['C:/demo/a.txt', 'C:/demo/b.txt'] });
    const result = await service.copyBatch([files.item.id, files.item.id]);
    assert.equal(result.count, 2);
    assert.equal(new Set(writtenFiles).size, 2);
    assert.ok(requests.every(command => command !== 'paste'));

    await assert.rejects(service.copyBatch([first.item.id, files.item.id]), /文字和文件需要分批/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard selection refuses text when the foreground changes during UI Automation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-selection-'));
  const store = await openClipboardStore(directory);
  const original = { hwnd: 20, pid: 30, processName: 'notepad.exe' };
  let snapshotReads = 0;
  const bridge = {
    onEvent() { return () => {}; },
    async request(command) {
      if (command === 'selection') return { text: 'private selected text', foreground: original };
      snapshotReads++;
      return { sequence: 10, foreground: snapshotReads === 1 ? original
        : { hwnd: 21, pid: 31, processName: 'keepassxc.exe' }, owner: { processName: 'notepad.exe' } };
    },
  };
  const service = createClipboardService({ store, clipboard: {}, bridge });
  try {
    const result = await service.copySelection();
    assert.deepEqual(result, { ok: false, reason: 'foreground-changed' });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service requires explicit capture, trusted source, and current clipboard sequence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-service-'));
  const store = await openClipboardStore(directory);
  let clipboardText = 'ordinary note';
  let snapshot = { sequence: 8, foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' },
    owner: { processName: 'notepad.exe', name: 'Notepad' } };
  const bridge = {
    onEvent() { return () => {}; },
    async request(command) { return command === 'snapshot' ? snapshot : { pasted: false }; },
  };
  const clipboard = {
    async read() { return [{ types: ['text/plain'], async getType() { return clipboardText; } }]; },
    async readText() { return clipboardText; },
    async writeText(value) { clipboardText = value; },
  };
  const service = createClipboardService({ store, clipboard, bridge });
  const event = { ...snapshot, privacyExcluded: false, files: [] };
  try {
    assert.deepEqual(await service.capture(event), { ignored: true });
    await service.setCaptureEnabled(true);
    assert.ok((await service.capture(event)).item);
    const helperWrite = { ...event, sequence: 8, helperWrite: true };
    assert.equal((await service.capture(helperWrite)).ignored, true);
    assert.equal(store.search('ordinary').length, 1);
    assert.equal(store.search('', { type: 'all' }).length, 1);
    snapshot = { ...snapshot, sequence: 9 };
    assert.equal((await service.capture(event)).reason, 'clipboard-changed');
    const excluded = { ...event, owner: { processName: 'keepassxc.exe' } };
    assert.equal((await service.capture(excluded)).ignored, true);
    const excludedForeground = { ...event, foreground: { processName: '1password.exe' } };
    assert.equal((await service.capture(excludedForeground)).reason, 'excluded-process');
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service skips content when the clipboard owner is unknown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-unknown-owner-'));
  const store = await openClipboardStore(directory);
  const snapshot = { sequence: 3, privacyExcluded: false, foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' }, files: [] };
  let clipboardReads = 0;
  const bridge = { onEvent() { return () => {}; }, async request() { return snapshot; } };
  const clipboard = { async read() { clipboardReads++; return []; } };
  const service = createClipboardService({ store, clipboard, bridge });
  try {
    await service.setCaptureEnabled(true);
    assert.equal((await service.capture(snapshot)).reason, 'unknown-source');
    assert.equal((await service.capture({ ...snapshot, files: ['C:/synthetic/test.txt'] })).reason, 'unknown-source');
    assert.equal(clipboardReads, 0);
    assert.equal(store.search('', { type: 'all' }).length, 0);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('guarded selection copy sends numeric focus arguments and accepts only the exact safe restoration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-guarded-copy-'));
  const store = await openClipboardStore(directory);
  const foreground = { hwnd: 20, pid: 30, processName: 'notepad.exe' };
  let state = { sequence: 10, privacyExcluded: false, helperWrite: false, foreground,
    owner: { processName: 'notepad.exe' } };
  let eventListener;
  let selectionCalls = 0;
  const calls = [];
  const bridge = {
    onEvent(listener) { eventListener = listener; return () => {}; },
    async request(command, args) {
      calls.push({ command, args });
      if (command === 'snapshot') return state;
      if (command === 'selection') {
        selectionCalls++;
        return selectionCalls === 2 ? { text: 'following selection', foreground } : { error: 'UI Automation unavailable' };
      }
      if (command === 'focus') return { ok: true };
      if (command === 'copy') {
        if (selectionCalls === 3) {
          state = { sequence: 13, privacyExcluded: false, helperWrite: false, foreground,
            owner: { processName: 'notepad.exe' } };
          eventListener(state);
          return { ok: false, error: 'clipboard restoration refused' };
        }
        eventListener({ sequence: 11 });
        state = { sequence: 12, privacyExcluded: false, helperWrite: true, foreground,
          owner: { processName: 'WindowsBridge.exe' } };
        eventListener(state);
        return { ok: true, text: 'guarded selection', sequence: 12, clipboardRestored: true, foreground };
      }
      throw new Error(`Unexpected bridge command: ${command}`);
    },
  };
  const service = createClipboardService({ store, clipboard: {}, bridge });
  try {
    await service.setCaptureEnabled(true);
    await store.updateSettings({ selectionCopyFallback: true });
    const first = await service.copySelection({ foreground });
    assert.deepEqual(first, { ok: true, text: 'guarded selection', source: 'guarded-copy' });
    assert.deepEqual(calls.find(call => call.command === 'focus').args, {
      foregroundHwnd: 20, pid: 30, allowedCurrentHwnd: 0,
    });
    assert.deepEqual(await service.copySelection({ foreground }), {
      ok: true, text: 'following selection', source: 'accessibility',
    });
    assert.deepEqual(await service.copySelection({ foreground }), { ok: false, reason: 'clipboard restoration refused' });
    assert.equal((await service.capture(state)).reason, 'self-write-sequence');
    eventListener(state);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.search('', { type: 'all' }).length, 0);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service returns stable write and guarded paste results and suppresses its own write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-paste-'));
  const store = await openClipboardStore(directory);
  let clipboardText = 'paste target';
  const calls = [];
  let snapshot = { sequence: 10, foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' },
    owner: { processName: 'notepad.exe' } };
  const bridge = {
    onEvent() { return () => {}; },
    async request(command, args) {
      calls.push({ command, args });
      return command === 'snapshot' ? snapshot : command === 'paste' ? { ok: false, error: 'blocked' } : { ok: true };
    },
  };
  const clipboard = {
    async read() { return [{ types: ['text/plain'], async getType() { return clipboardText; } }]; },
    async writeText(value) { clipboardText = value; snapshot = { ...snapshot, sequence: snapshot.sequence + 1 }; },
  };
  const service = createClipboardService({ store, clipboard, bridge });
  try {
    await service.setCaptureEnabled(true);
    const captured = await service.capture({ ...snapshot, privacyExcluded: false, files: [] });
    assert.ok(captured.item);
    await store.updateSettings({ autoPaste: true });
    let hidden = false;
    const result = await service.paste(captured.item.id, { allowedCurrentHwnd: 99,
      beforeSend: async () => { hidden = true; } });
    assert.equal(hidden, true);
    assert.equal(result.pasted, false);
    assert.deepEqual(calls.slice(-2), [{ command: 'focus', args: {
      foregroundHwnd: 20, pid: 30, allowedCurrentHwnd: 99,
    } }, { command: 'paste', args: {
      foregroundHwnd: 20, pid: 30, sequence: 11,
    } }]);
    const ownWrite = await service.capture({ ...snapshot, privacyExcluded: false, files: [] });
    assert.equal(ownWrite.reason, 'self-write-sequence');
    assert.equal(result.written, true);
    assert.equal(result.reason, 'paste-refused');
    store.enqueueStack(captured.item);
    assert.deepEqual(service.getState().items, [{ id: captured.item.id, preview: 'paste target' }]);
    const nextResult = await service.pasteNext();
    assert.equal(nextResult.written, true);
    assert.equal(store.peekStack(), null);
    assert.equal(service.getState().length, 0);
    const callsBeforeNullTarget = calls.length;
    const nullTarget = await service.paste(captured.item.id, { foreground: { hwnd: null, pid: null } });
    assert.equal(nullTarget.reason, 'no-target');
    assert.equal(calls.slice(callsBeforeNullTarget).some(call => call.command === 'focus'), false);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service retries only while the native sequence remains unchanged', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-retry-'));
  const store = await openClipboardStore(directory);
  let snapshot = { sequence: 4, foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' },
    owner: { processName: 'notepad.exe' } };
  let reads = 0;
  const bridge = {
    onEvent() { return () => {}; },
    async request(command) { return command === 'snapshot' ? snapshot : { ok: true }; },
  };
  const clipboard = { async read() { reads++; snapshot = { ...snapshot, sequence: 5 }; throw new Error('busy'); } };
  const service = createClipboardService({ store, clipboard, bridge });
  try {
    await service.setCaptureEnabled(true);
    const result = await service.capture({ ...snapshot, sequence: 4, files: [] });
    assert.equal(result.reason, 'clipboard-changed');
    assert.equal(reads, 1);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service enforces combined rich-text size before materializing Blob strings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-aggregate-size-'));
  const store = await openClipboardStore(directory);
  let materialized = 0;
  const oversizedBlob = { size: 600 * 1024, async text() { materialized++; return 'x'; } };
  const snapshot = { sequence: 6, foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' },
    owner: { processName: 'notepad.exe' } };
  const bridge = { onEvent() { return () => {}; }, async request() { return snapshot; } };
  const clipboard = { async read() { return [{ types: ['text/plain', 'text/html'], getType() { return oversizedBlob; } }]; } };
  let notice = '';
  const service = createClipboardService({ store, clipboard, bridge, onNotice: message => { notice = message; } });
  try {
    await service.setCaptureEnabled(true);
    const result = await service.capture({ ...snapshot, files: [] });
    assert.equal(result.reason, 'too-large-or-invalid');
    assert.equal(materialized, 0);
    assert.match(notice, /合计超过 1 MiB/);
  } finally {
    await service.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clipboard service retains HTML/RTF when a rich link is pasted normally and rejects plain image paste', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reversewear-rich-paste-'));
  const store = await openClipboardStore(directory);
  const rich = await store.addItem({ type: 'link', text: 'https://example.org',
    html: '<a href="https://example.org">Example</a>', rtf: String.raw`{\rtf1 Example}`, });
  const image = await store.addItem({ type: 'image', imageBuffer: Buffer.from('image'), imageWidth: 2, imageHeight: 2 });
  const writeCalls = [];
  const bridge = { onEvent() { return () => {}; }, async request(command) {
    return command === 'focus' ? { ok: true } : { sequence: 5,
      foreground: { hwnd: 20, pid: 30, processName: 'notepad.exe' }, owner: { processName: 'notepad.exe' } };
  } };
  class TestClipboardItem { constructor(data) { this.data = data; } }
  const clipboard = {
    async writeText(text) { writeCalls.push({ text }); },
    async write(items) { writeCalls.push({ items }); },
  };
  const service = createClipboardService({ store, clipboard, ClipboardItemClass: TestClipboardItem, bridge });
  try {
    const result = await service.paste(rich.item.id, { allowedCurrentHwnd: 99, beforeSend: async () => {} });
    assert.equal(result.written, true);
    assert.equal(writeCalls.length, 1);
    const formats = writeCalls[0].items[0].data;
    assert.equal(await formats['text/plain'].text(), 'https://example.org');
    assert.equal(await formats['text/html'].text(), '<a href="https://example.org">Example</a>');
    assert.equal(await formats['text/rtf'].text(), String.raw`{\rtf1 Example}`);
    const imageResult = await service.paste(image.item.id, { plainText: true });
    assert.equal(imageResult.reason, 'plain-text-unavailable');
    assert.equal(imageResult.written, false);
    assert.equal(writeCalls.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
