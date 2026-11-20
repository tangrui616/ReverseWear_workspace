import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRestartingBridge } from '../../desktop_suite/windowsBridge.mjs';

function fakeProcess(ready = true) {
  const child = new EventEmitter();
  child.pid = 42;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', line => {
    for (const request of line.trim().split('\n')) {
      if (!request) continue;
      const message = JSON.parse(request);
      child.stdout.write(JSON.stringify({ id: message.id, result: { sequence: 7 } }) + '\n');
    }
  });
  child.kill = () => {
    if (child.exited) return;
    child.exited = true;
    child.emit('exit', 1, null);
  };
  if (ready) setImmediate(() => child.stdout.write('{"event":"ready"}\n'));
  return child;
}

function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for bridge state.'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('restarting bridge restores requests after a helper exit', async () => {
  const states = [];
  const processes = [];
  const bridge = createRestartingBridge('fake-helper', {
    timeoutMs: 100,
    retryDelays: [5, 10, 15],
    spawnChild: () => {
      const child = fakeProcess();
      processes.push(child);
      return child;
    },
    onStateChanged: state => states.push(state),
  });
  try {
    await waitFor(() => bridge.getState().available);
    assert.deepEqual(await bridge.request('snapshot'), { sequence: 7 });
    processes[0].kill();
    await waitFor(() => bridge.getState().available && processes.length === 2);
    assert.deepEqual(await bridge.request('snapshot'), { sequence: 7 });
    assert.ok(states.some(state => state.attempts === 1 && !state.available));
  } finally {
    bridge.close();
  }
});

test('restarting bridge stops after three failed startup attempts', async () => {
  let attempts = 0;
  const bridge = createRestartingBridge('fake-helper', {
    timeoutMs: 20,
    retryDelays: [5, 10, 15],
    spawnChild: () => {
      attempts++;
      return fakeProcess(false);
    },
  });
  try {
    await waitFor(() => bridge.getState().attempts === 3 && attempts === 4 && !bridge.getState().available);
    assert.equal(attempts, 4);
  } finally {
    bridge.close();
  }
});
