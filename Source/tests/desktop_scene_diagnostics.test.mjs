import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSceneDiagnostics } from '../desktop_scene_diagnostics.mjs';

test('reports failed scene resource paths once and forgets recovered or retried resources', () => {
  const id = 'A'.repeat(32);
  const diagnostics = createSceneDiagnostics();
  const asset = new URL(`https://stilltime-app.invalid/wallpapers/scene/${id}/asset?name=models%2Fmissing.json`);
  const particle = new URL(`https://stilltime-app.invalid/wallpapers/particle-texture?id=${id}&name=particle%2Fmissing`);
  diagnostics.record(asset, 404);
  diagnostics.record(asset, 404);
  diagnostics.record(particle, 400);
  assert.deepEqual(diagnostics.report(id), { requests: 3, failures: [
    { name: 'models/missing.json', status: 404 },
    { name: 'materials/particle/missing.tex', status: 400 },
  ], omitted: false });
  diagnostics.record(asset, 200);
  assert.deepEqual(diagnostics.report(id).failures, [{ name: 'materials/particle/missing.tex', status: 400 }]);
  diagnostics.begin(id);
  assert.deepEqual(diagnostics.report(id), { requests: 0, failures: [], omitted: false });
});
