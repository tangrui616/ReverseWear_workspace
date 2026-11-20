import test from 'node:test';
import assert from 'node:assert/strict';
import { runArchitectureChecks } from '../qa/architecture-check.mjs';

test('architecture boundaries and runtime contracts match the accepted baseline', async () => {
  const result = await runArchitectureChecks();
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.equal(result.summary.cycles, 0);
  assert.equal(result.summary.largeStyles, 1);
  assert.equal(result.summary.ipc.commands.count, 134);
  assert.equal(result.summary.ipc.events.count, 16);
  assert.equal(result.summary.ipc.suiteOperations.count, 28);
});
