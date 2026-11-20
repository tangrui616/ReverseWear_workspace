import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { electronChecks } from './check-registry.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const report = await mkdtemp(path.join(tmpdir(), 'ReverseWear-Regression-'));
const electron = process.env.REVERSEWEAR_QA_ELECTRON ?? [
  path.join(project, '.electron-45', 'electron.exe'),
  path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe'),
].find(existsSync);
assert.ok(electron, '找不到 Electron，请指定 REVERSEWEAR_QA_ELECTRON。');
const wallpaperOnly = process.argv.includes('--wallpaper-only');
const checkWallpaper = wallpaperOnly || !process.argv.includes('--skip-workshop');
const onlyArgument = process.argv.find(value => value.startsWith('--only='));
const requestedChecks = onlyArgument?.slice('--only='.length).split(',').map(value => value.trim()).filter(Boolean);
if (process.argv.includes('--only') || (onlyArgument && !requestedChecks.length)) {
  console.error('FAIL --only 需要至少一个已登记的检查名称。');
  process.exit(1);
}
const unknownChecks = requestedChecks?.filter(name => !electronChecks.some(check => check.id === name)) ?? [];
if (unknownChecks.length) {
  console.error(`FAIL 未知 Electron 验收项目：${unknownChecks.join(', ')}`);
  process.exit(1);
}

function run(command, args, env, timeout = 150_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    const watchdog = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.unref();
      } else child.kill('SIGKILL');
    }, timeout);
    child.on('error', error => { clearTimeout(watchdog); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, out, err });
    });
  });
}

let nodeFailure = false;
if (!wallpaperOnly && !process.argv.includes('--skip-node')) {
  const node = await run(process.execPath, ['--test'], process.env);
  await writeFile(path.join(report, 'node.log'), node.out + '\n' + node.err);
  nodeFailure = node.code !== 0;
  console.log(`${nodeFailure ? 'FAIL' : 'PASS'} node${nodeFailure ? ` · exit ${node.code} · ${report}/node.log` : ''}`);
}
const fullChecks = Object.fromEntries(electronChecks
  .filter(check => check.isolated && (check.id !== 'wallpaper' || checkWallpaper))
  .map(check => [check.id, check]));
if (!process.argv.includes('--skip-system-clipboard')) fullChecks.capture = electronChecks.find(check => check.id === 'capture');
const excludedChecks = requestedChecks?.filter(name => !fullChecks[name]) ?? [];
if (excludedChecks.length) {
  console.error(`FAIL 所请求项目被现有跳过参数排除：${excludedChecks.join(', ')}`);
  process.exit(1);
}
const checks = wallpaperOnly ? { wallpaper: fullChecks.wallpaper }
  : requestedChecks ? Object.fromEntries(requestedChecks.map(name => [name, fullChecks[name]]))
    : fullChecks;
if (checks.wallpaper || checks.risk) {
  const sourceFixtures = path.join(project, 'qa', 'fixtures', 'wallpaper');
  const stagedFixtures = path.join(report, 'fixtures', 'wallpaper');
  await cp(sourceFixtures, stagedFixtures, {
    recursive: true,
    filter: source => path.basename(source) !== 'preview.jpg',
  });
  const sharedPreview = path.join(stagedFixtures, '普通媒体', '子目录', '验收图片.jpg');
  await Promise.all([
    copyFile(sharedPreview, path.join(stagedFixtures, '缺失场景', 'preview.jpg')),
    copyFile(sharedPreview, path.join(stagedFixtures, '白屏场景', 'preview.jpg')),
  ]);
}
let fail = nodeFailure;
for (const [test, success] of Object.entries(checks)) {
  const root = path.join(report, test);
  const settings = path.join(root, 'Settings', 'Stilltime');
  const evidence = path.join(root, 'wallpaper.json');
  await mkdir(settings, { recursive: true });
  if (test === 'wallpaper' || test === 'risk') {
    const fixtures = path.join(report, 'fixtures', 'wallpaper');
    const folders = ['普通媒体', '缺失场景', '白屏场景', '不存在'].map(name => path.join(fixtures, name));
    await writeFile(path.join(settings, 'settings.json'), JSON.stringify({ schemaVersion: 1, folders, state: {} }));
  }
  const flags = checks[test]?.flags.map(value => `--${value}`) ?? [];
  const descriptor = checks[test];
  const checking = descriptor?.special === 'wallpaper' ? evidence : test;
  const result = await run(electron, [...flags, project], {
    ...process.env,
    STILLTIME_DEV_DATA_ROOT: root,
    STILLTIME_DEV_CHECK: checking,
    ...(descriptor?.translationAssets ? { STILLTIME_DEV_TRANSLATION_ASSETS: descriptor.translationAssets } : {}),
    STILLTIME_DEV_DICTIONARY_CACHE: descriptor?.translationAssets ? (process.env.STILLTIME_DEV_DICTIONARY_CACHE ?? '') : '',
    ...((test === 'risk' || wallpaperOnly) ? { STILLTIME_DEV_STEAM_ROOT: path.join(root, 'no-steam') } : {}),
    STILLTIME_DEV_WALLPAPER_FIXTURE_ONLY: wallpaperOnly ? '1' : '',
  }, (descriptor?.timeoutSeconds ?? 150) * 1000);
  await writeFile(path.join(root, 'stdout.log'), result.out);
  await writeFile(path.join(root, 'stderr.log'), result.err);
  const passed = result.code === 0 && result.out.includes(descriptor?.success ?? success) &&
    (test !== 'wallpaper' || !(JSON.parse(await readFile(evidence, 'utf8'))).error);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${test}`);
  if (!passed) fail = true;
}
console.log('Logs: ' + report);
if (fail) process.exitCode = 1;
