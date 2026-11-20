import { execFile } from 'node:child_process';
import { readdir, lstat, realpath, rm, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runName = /^Run_CodexV1-[\w-]+$/;
const suiteName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const markerName = '.reversewear-test-work.json';

async function treeBytes(root) {
  let bytes = 0;
  let files = 0;
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(target);
      else { bytes += info.size; files += 1; }
    }
  }
  const info = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info?.isDirectory() && !info.isSymbolicLink()) await visit(root);
  return { bytes, files };
}

async function assertChildDirectory(target, parent) {
  const lexical = path.resolve(target);
  const [run, suite, extra] = path.relative(parent, lexical).split(path.sep);
  const [resolvedTarget, resolvedParent] = await Promise.all([realpath(lexical), realpath(parent)]);
  if (!runName.test(run) || !suiteName.test(suite ?? '') || extra !== undefined ||
      resolvedTarget !== path.join(resolvedParent, run, suite) || resolvedParent !== path.resolve(parent)) {
    throw new Error(`路径超出测试临时目录范围：${target}`);
  }
  for (const dir of [parent, path.dirname(lexical), lexical]) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`拒绝清理链接或非目录：${dir}`);
  }
  return resolvedTarget;
}

export async function removeOwnedWork(target, workRoot) {
  const resolved = await assertChildDirectory(target, workRoot);
  const markerPath = path.join(resolved, markerName);
  if (!(await lstat(markerPath)).isFile()) throw new Error('临时目录的标记不是普通文件。');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.schema !== 1 || marker.status !== 'passed') throw new Error('临时目录没有成功运行标记。');
  if (marker.childPid && isProcessAlive(marker.childPid)) throw new Error(`验收进程仍在运行：${marker.childPid}`);
  const escapedPath = resolved.replaceAll("'", "''");
  if (process.platform === 'win32') {
    const command = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='ReverseWear.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf('${escapedPath}', [StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object -ExpandProperty ProcessId`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
    if (stdout.trim()) throw new Error(`检测到仍在运行的测试进程：${stdout.trim()}`);
  }
  await rm(resolved, { recursive: true, force: false });
}

function isProcessAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function runStorageCommand({ reportsRoot, workRoot, dictionaryCache, apply, prune }) {
  if (!prune) {
    for (const [label, folder] of [['验收报告', reportsRoot], ['测试临时数据', workRoot], ['共享词典缓存', dictionaryCache]]) {
      const size = await treeBytes(folder);
      console.log(`${label}：${size.files} 个文件，${(size.bytes / 1024 ** 3).toFixed(3)} GiB，${folder}`);
    }
    return 0;
  }
  const entries = await readdir(workRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  let removed = 0;
  let failures = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !runName.test(entry.name)) continue;
    const parent = path.join(workRoot, entry.name);
    const removedBeforeRun = removed;
    const suites = await readdir(parent, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const suite of suites) {
      if (!suite.isDirectory() || !suiteName.test(suite.name)) continue;
      const folder = path.join(parent, suite.name);
      try {
        const resolved = await assertChildDirectory(folder, workRoot);
        const markerFile = path.join(resolved, markerName);
        const markerInfo = await lstat(markerFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!markerInfo?.isFile()) continue;
        const marker = JSON.parse(await readFile(markerFile, 'utf8'));
        if (marker.schema !== 1 || marker.status !== 'passed') continue;
        const size = await treeBytes(folder);
        console.log(`${apply ? '清理' : '可清理'} · ${size.bytes} 字节 · ${folder}`);
        if (apply) { await removeOwnedWork(folder, workRoot); removed += 1; }
      } catch (error) {
        failures += 1;
        console.error(`无法处理 ${folder}：${error.message}`);
      }
    }
    if (removed > removedBeforeRun && (await readdir(parent)).length === 0) await rmdir(parent);
  }
  console.log(apply ? `已清理 ${removed} 个成功测试临时目录。` : '预览模式，没有删除文件。');
  return failures ? 1 : 0;
}
