import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commands, events, suiteOperations } from '../ipc/contract.mjs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

test('IPC contract has unique channels and a preload API for every request', () => {
  const channels = Object.values(commands).map(entry => entry.channel);
  assert.equal(new Set(channels).size, channels.length);
  assert.equal(channels.length, 134);
  assert.equal(commands['workbench:folders'].write, false);
  assert.equal(commands['workbench:create-folder'].write, true);
  assert.equal(commands['workbench:move-record'].write, true);
  for (const [key, entry] of Object.entries(commands)) {
    assert.equal(entry.channel, 'stilltime:' + key);
    assert.ok(entry.methods.length > 0, key + ' has no public preload method');
  }
});

test('capture popup access is limited to its save and close commands', () => {
  const popupCommands = Object.entries(commands)
    .filter(([, entry]) => entry.capturePopup)
    .map(([key]) => key)
    .sort();
  assert.deepEqual(popupCommands, ['capture:close', 'capture:save']);
});

test('events have a known channel, subscribers, and recipient windows', () => {
  assert.equal(Object.keys(events).length, 16);
  for (const [key, entry] of Object.entries(events)) {
    assert.equal(entry.channel, 'stilltime:' + key);
    assert.ok(entry.methods.length > 0, key + ' has no preload listener');
    assert.ok(entry.recipients.length > 0, key + ' has no recipient');
  }
});

test('suite operations carry explicit window roles', () => {
  assert.equal(Object.keys(suiteOperations).length, 28);
  for (const [operation, entry] of Object.entries(suiteOperations)) {
    assert.ok(entry.roles.length > 0, operation + ' has no allowed role');
    assert.ok(entry.roles.every(role => ['main', 'clipboard', 'launcher', 'selection', 'pin'].includes(role)));
  }
  assert.deepEqual(suiteOperations['window.control'].roles, ['clipboard']);
  assert.deepEqual(suiteOperations['history.paste'].roles, ['clipboard']);
  assert.deepEqual(suiteOperations['history.copy-batch'].roles, ['main']);
});

test('generated preload files and IPC registrations match the contract', () => {
  const generator = fileURLToPath(new URL('../ipc/generate-preloads.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('generated preload aliases target their contract channel and keep their adapters', () => {
  const exposed = {};
  const calls = [];
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (...args) => calls.push(args),
      on: (channel, listener) => { listeners.set(channel, listener); },
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
    webUtils: { getPathForFile: file => file.localPath ?? '' },
  };
  for (const file of ['preload.cjs', 'capture-preload.cjs', 'suite-preload.cjs']) {
    runInNewContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
      require(name) { assert.equal(name, 'electron'); return electron; },
    }, { filename: file });
  }
  const find = name => name.split('.').reduce((current, key) => current[key], exposed);
  for (const command of Object.values(commands)) {
    for (const name of command.methods) {
      const qualified = name.startsWith('capturePreload.') ? name.replace('capturePreload.', 'stilltimeCapture.')
        : name === 'desktopSuite.invoke' ? name : 'stilltimeDesktop.' + name;
      const invoke = find(qualified);
      if (name === 'workbench.dropFiles') invoke([{ localPath: 'F:/fixture.pdf' }, {}]);
      else invoke('argument 1', 'argument 2');
      const [channel, ...args] = calls.pop();
      assert.equal(channel, command.channel, qualified);
      if (name === 'workbench.dropFiles') assert.deepEqual([...args[0]], ['F:/fixture.pdf']);
      else assert.equal(args.length, invoke.length, qualified);
    }
  }
  for (const event of Object.values(events)) {
    for (const name of event.methods) {
      let received;
      const unsubscribe = find(name)(value => { received = value; });
      const listener = listeners.get(event.channel);
      assert.equal(typeof listener, 'function', name);
      const payload = { label: 'synthetic' };
      listener({ sender: 'hidden' }, payload);
      assert.equal(received, payload);
      if (typeof unsubscribe === 'function') {
        unsubscribe();
        assert.equal(listeners.has(event.channel), false);
      }
    }
  }
});
