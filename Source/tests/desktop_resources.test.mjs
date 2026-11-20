import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopResources } from '../desktop_resources.mjs';

const APP_ORIGIN = 'https://stilltime-app.invalid';

function pack(entries) {
  const files = [...entries].map(([name, value]) => ({ name, bytes: Buffer.from(value) }));
  const tableSize = files.reduce((total, file) => total + 4 + Buffer.byteLength(file.name) + 8, 0);
  let relative = 0;
  const table = [];
  for (const file of files) {
    const name = Buffer.from(file.name);
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32LE(name.length);
    const metadata = Buffer.alloc(8);
    metadata.writeUInt32LE(relative);
    metadata.writeUInt32LE(file.bytes.length, 4);
    table.push(nameLength, name, metadata);
    relative += file.bytes.length;
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8);
  header.write('PKGV', 4);
  header.write('0023', 8);
  header.writeUInt32LE(files.length, 12);
  assert.equal(tableSize, table.reduce((total, part) => total + part.length, 0));
  return Buffer.concat([header, ...table, ...files.map((file) => file.bytes)]);
}

test('desktop resources serve the app, sanitized library metadata, media ranges and bounded scene assets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stilltime-desktop-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staticDirectory = path.join(root, 'dist');
  const projectRoot = path.join(root, 'workshop', 'example');
  await mkdir(staticDirectory, { recursive: true });
  await mkdir(path.join(staticDirectory, 'startup', 'voice'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(staticDirectory, 'index.html'), '<!doctype html>Stilltime');
  await writeFile(path.join(staticDirectory, 'startup', 'voice', 'line-1.mp3'), '0123456789');
  await writeFile(path.join(projectRoot, 'preview.jpg'), Buffer.from([1, 2, 3]));
  await writeFile(path.join(projectRoot, 'video.mp4'), Buffer.from('0123456789'));
  const packageFile = path.join(projectRoot, 'scene.pkg');
  const clorindeModel = 'models/Clorinde’s Quiet Reveal 🌙✨_134098018.json';
  const clorindeMaterial = 'materials/Clorinde’s Quiet Reveal 🌙✨_134098018.json';
  const clorindeTexture = 'Clorinde’s Quiet Reveal 🌙✨_134098018';
  await writeFile(packageFile, pack([
    ['scene.json', '{"objects":[]}'],
    ['models/合法..json', '{"name":"safe"}'],
    ['materials/demo.tex', 'texture-bytes'],
    [clorindeModel, '{"name":"Clorinde"}'],
    [clorindeMaterial, '{"name":"Unicode material"}'],
    [`materials/${clorindeTexture}.tex`, 'unicode-texture-bytes'],
  ]));

  const scanRoot = path.join(root, 'workshop');
  const video = {
    id: 'video-id', title: '本地视频', type: 'video', playable: true, file: path.join(projectRoot, 'video.mp4'),
    preview: path.join(projectRoot, 'preview.jpg'), projectRoot, scanRoot, fileName: 'video.mp4',
    createdAtMs: 123, modifiedAtMs: 456, sizeBytes: 10,
  };
  const scene = {
    id: 'S'.repeat(32), title: '场景', type: 'scene', playable: false,
    file: packageFile, preview: path.join(projectRoot, 'preview.jpg'), projectRoot, scanRoot,
  };
  const items = [video, scene];
  const handle = createDesktopResources({
    staticDirectory,
    getLibrary: async () => ({ items }),
    getItem: async (id) => items.find((item) => item.id === id) ?? null,
    steamRoot: root,
  });
  const request = (resource, init) => handle(new Request(new URL(resource, APP_ORIGIN), init));

  const homepage = await request('/');
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /Stilltime/);

  const voice = await request('/startup/voice/line-1.mp3', { headers: { range: 'bytes=2-5' } });
  assert.equal(voice.status, 206);
  assert.equal(voice.headers.get('content-type'), 'audio/mpeg');
  assert.equal(voice.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await voice.text(), '2345');

  const library = await request('/api/library').then((response) => response.json());
  assert.equal(library.stats.video, 1);
  assert.equal(library.items[0].modifiedAtMs, 456);
  assert.equal(JSON.stringify(library).includes(projectRoot), false);

  const preview = await request('/media/video-id/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())], [1, 2, 3]);

  const rangedVideo = await request('/media/video-id/background', { headers: { range: 'bytes=2-5' } });
  assert.equal(rangedVideo.status, 206);
  assert.equal(rangedVideo.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await rangedVideo.text(), '2345');

  const sceneAssetUrl = `/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent('models/合法..json')}`;
  const model = await request(sceneAssetUrl);
  assert.equal(model.status, 200);
  assert.deepEqual(await model.json(), { name: 'safe' });

  const unicodeModel = await request(`/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent(clorindeModel)}`);
  assert.equal(unicodeModel.status, 200);
  assert.deepEqual(await unicodeModel.json(), { name: 'Clorinde' });

  const unicodeMaterial = await request(`/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent(clorindeMaterial)}`);
  assert.equal(unicodeMaterial.status, 200);
  assert.deepEqual(await unicodeMaterial.json(), { name: 'Unicode material' });

  const texture = await request(`/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent('materials/demo.tex')}`, {
    headers: { range: 'bytes=0-6' },
  });
  assert.equal(texture.status, 206);
  assert.equal(await texture.text(), 'texture');

  const unicodeTexture = await request(`/wallpapers/particle-texture?id=${scene.id}&name=${encodeURIComponent(clorindeTexture)}`);
  assert.equal(unicodeTexture.status, 200);
  assert.equal(await unicodeTexture.text(), 'unicode-texture-bytes');

  assert.equal((await request(`/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent('models/../scene.json')}`)).status, 400);
  assert.equal((await request(`/wallpapers/scene/${scene.id}/asset?name=${encodeURIComponent('models/bad\u0001name.json')}`)).status, 400);
  assert.equal((await request('/../../secret.txt')).status, 404);
  assert.equal((await request('/')).status, 200);
  assert.equal((await handle(new Request('https://example.com/'))).status, 403);
});
