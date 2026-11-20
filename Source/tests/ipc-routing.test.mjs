import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands } from '../ipc/contract.mjs';
import { createHandlerRegistry, sendEvent } from '../main/ipc.mjs';
import { APP } from '../main/origins.mjs';
import { createWriteQueue } from '../main/write-queue.mjs';

function fixture() {
  const handlers = new Map();
  const main = { webContents: {}, isDestroyed: () => false };
  const capture = { webContents: {} };
  const ipc = { handle: (channel, handler) => handlers.set(channel, handler) };
  let queued = 0;
  const registry = createHandlerRegistry(ipc, {
    win: main, getCaptureWindow: () => capture,
    serialize: operation => { queued += 1; return Promise.resolve().then(operation); },
  });
  const request = (key, sender, url, parent, ...args) =>
    handlers.get(commands[key].channel)({ sender, senderFrame: { url, parent } }, ...args);
  return { ...registry, request, main, capture, queued: () => queued };
}

test('registry detects omitted and duplicate registrations', () => {
  const ipc = fixture();
  ipc.register('state:load', () => ({}));
  assert.throws(() => ipc.register('state:load', () => ({})), /Duplicate workbench IPC/);
  assert.throws(() => ipc.register('unknown', () => {}), /Unknown workbench IPC/);
  assert.throws(ipc.assertComplete, /Missing workbench IPC/);
  for (const key of Object.keys(commands)) {
    if (key !== 'suite:invoke' && key !== 'state:load') ipc.register(key, () => {});
  }
  ipc.assertComplete();
});

test('only the trusted main frame can write a workbench note', async () => {
  const ipc = fixture();
  const note = { body: 'synthetic note' };
  ipc.register('workbench:save-note', input => input);
  ipc.register('state:load', () => note);
  assert.throws(() => ipc.request('workbench:save-note', {}, APP + '/', null, note), /Unauthorized/);
  assert.throws(() => ipc.request('workbench:save-note', ipc.main.webContents, APP + '/', {}, note), /Unauthorized/);
  assert.throws(() => ipc.request('workbench:save-note', ipc.main.webContents, APP + '/capture.html', null, note), /Unauthorized/);
  assert.throws(() => ipc.request('workbench:save-note', ipc.capture.webContents, APP + '/capture.html', null, note), /Unauthorized/);
  assert.equal(ipc.request('state:load', ipc.main.webContents, APP + '/?verify=1', null), note);
  assert.equal(ipc.queued(), 0);
  assert.equal(await ipc.request('workbench:save-note', ipc.main.webContents, APP + '/', null, note), note);
  assert.equal(ipc.queued(), 1);
});

test('capture grants apply only to the real popup at its exact main-frame URL', async () => {
  const ipc = fixture();
  const url = APP + '/capture.html';
  const input = { text: 'synthetic capture' };
  ipc.register('capture:save', entry => entry);
  ipc.register('capture:close', () => true);
  ipc.register('capture:ideas', () => []);
  assert.equal(await ipc.request('capture:save', ipc.capture.webContents, url, null, input), input);
  assert.equal(ipc.request('capture:close', ipc.capture.webContents, url, null), true);
  assert.throws(() => ipc.request('capture:save', {}, url, null, input), /Unauthorized capture/);
  assert.throws(() => ipc.request('capture:save', ipc.capture.webContents, url + '?x=1', null, input), /Unauthorized capture/);
  assert.throws(() => ipc.request('capture:save', ipc.capture.webContents, url, {}, input), /Unauthorized capture/);
  assert.throws(() => ipc.request('capture:ideas', ipc.capture.webContents, url, null), /Unauthorized capture/);
  assert.deepEqual(ipc.request('capture:ideas', ipc.main.webContents, APP + '/', null), []);
  assert.equal(ipc.queued(), 1);
});

test('event entry forwards the contract channel and positional payload', () => {
  const sent = [];
  const target = { send: (...args) => sent.push(args) };
  sendEvent(target, 'risk:activity', false);
  sendEvent(target, 'suite:changed');
  assert.deepEqual(sent, [['stilltime:risk:activity', false], ['stilltime:suite:changed']]);
  assert.throws(() => sendEvent(target, 'state:load'), /Unknown workbench event/);
});

test('serial writes retain order across an error and shutdown waits for the queue', async () => {
  const queue = createWriteQueue();
  const order = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = queue.serialize(async () => {
    order.push('first');
    await held;
    throw new Error('fixture failure');
  });
  const firstRejected = assert.rejects(first, /fixture failure/);
  const second = queue.serialize(() => { order.push('second'); return 'saved'; });
  const closed = queue.afterWrites(() => order.push('closed'));
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  release();
  await firstRejected;
  assert.equal(await second, 'saved');
  await closed;
  assert.deepEqual(order, ['first', 'second', 'closed']);
});
