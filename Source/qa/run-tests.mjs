import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rmdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { checkRegistry, listChecks } from './check-registry.mjs';
import { removeOwnedWork, runStorageCommand } from './test-storage.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const electronPath = valueAfter('--electron');
const external = process.argv.includes('--external');
process.stdout.setDefaultEncoding('utf8');

function valueAfter(name) {
  const position = process.argv.indexOf(name);
  return position < 0 ? '' : process.argv[position + 1] ?? '';
}

function printList() {
  for (const check of checkRegistry) {
    const state = check.isolated ? '默认全测' : '需显式启用';
    console.log(`${check.id.padEnd(16)} ${state.padEnd(12)} ${check.label}${check.requires?.length ? ` · 依赖：${check.requires.join('、')}` : ''}`);
  }
}

function validateRegistry(registry = checkRegistry) {
  if (!Array.isArray(registry) || registry.length === 0) throw new Error('测试登记表为空。');
  const ids = new Set();
  for (const check of registry) {
    if (!check.id || ids.has(check.id)) throw new Error(`测试登记表存在空名称或重复编号：${check.id ?? '(空)'}`);
    ids.add(check.id);
    if (!['node', 'electron'].includes(check.kind) || !check.label || !check.success ||
        !Number.isFinite(check.timeoutSeconds) || check.timeoutSeconds <= 0) {
      throw new Error(`测试登记项配置不完整：${check.id}`);
    }
    if (check.kind === 'electron' && (!['workbench', 'focus'].includes(check.page) || !Array.isArray(check.steps) ||
        !check.steps.length || check.steps.some(step => !step.module || !step.exportName || !Array.isArray(step.args)))) {
      throw new Error(`Electron 登记项缺少页面或分发入口：${check.id}`);
    }
  }
}

function selectByIds(ids, registry = checkRegistry, includeExternal = external) {
  const unknown = ids.filter(id => !registry.some(check => check.id === id));
  if (unknown.length) throw new Error(`未知测试项目：${unknown.join(', ')}`);
  const restricted = ids.filter(id => registry.find(check => check.id === id)?.isolated === false);
  if (restricted.length && !includeExternal) throw new Error(`所选项目需要给启动脚本加 -IncludeExternal，直接调用 Node 时加 --external：${restricted.join(', ')}`);
  return registry.filter(check => ids.includes(check.id));
}

async function selectChecks() {
  if (process.argv.includes('--list')) {
    printList();
    return [];
  }
  const only = valueAfter('--only').split(',').map(value => value.trim()).filter(Boolean);
  let selected = only.length ? selectByIds(only) : listChecks({ includeExternal: external });
  if (process.argv.includes('--menu')) {
    printList();
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const input = await terminal.question('输入项目标识（例如 node,v23），直接回车运行默认全测：');
    terminal.close();
    if (input?.trim()) {
      const requested = input.split(',').map(value => value.trim()).filter(Boolean);
      selected = selectByIds(requested);
    }
  }
  return selected;
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}

function failureReason(output) {
  const errors = output.split(/\r?\n/).filter(line => /^(?:AssertionError\b|(?:Type|Range|Syntax)?Error:|\[Error:)/.test(line));
  return errors.at(-1)?.slice(0, 600) || '';
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
  } else child.kill('SIGKILL');
}

async function runProcess(command, args, env, stdoutPath, stderrPath, timeoutSeconds, cwd = source, windowsHide = true) {
  const stdout = await import('node:fs').then(({ createWriteStream }) => createWriteStream(stdoutPath));
  const stderr = await import('node:fs').then(({ createWriteStream }) => createWriteStream(stderrPath));
  const started = Date.now();
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide });
  let outTail = '';
  let errTail = '';
  let timedOut = false;
  child.stdout.on('data', chunk => { stdout.write(chunk); outTail = tail(outTail + chunk.toString()); });
  child.stderr.on('data', chunk => { stderr.write(chunk); errTail = tail(errTail + chunk.toString()); });
  const watchdog = setTimeout(() => { timedOut = true; killTree(child); }, timeoutSeconds * 1000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  return { ...result, pid: child.pid, command: `${command} ${args.join(' ')}`, timedOut,
    elapsedMs: Date.now() - started, stdoutTail: outTail, stderrTail: errTail };
}

function yaml(value) {
  return JSON.stringify(String(value));
}

function nodeTestCount(output) {
  const match = output.match(/^# tests (\d+)$/m);
  return match ? Number(match[1]) : null;
}

function missingRequirements(check) {
  return (check.requires ?? []).filter(item => item.includes(':') && !item.startsWith('系统') && !item.startsWith('全局') && !item.startsWith('PowerShell'))
    .filter(item => !existsSync(item));
}

async function prepareWallpaperFixtures(report, settingsPath) {
  const sourceFixtures = path.join(source, 'qa', 'fixtures', 'wallpaper');
  const staged = path.join(path.dirname(settingsPath), 'fixtures', 'wallpaper');
  await cp(sourceFixtures, staged, { recursive: true, filter: item => path.basename(item) !== 'preview.jpg' });
  const preview = path.join(staged, '普通媒体', '子目录', '验收图片.jpg');
  await Promise.all([
    cp(preview, path.join(staged, '缺失场景', 'preview.jpg')),
    cp(preview, path.join(staged, '白屏场景', 'preview.jpg')),
  ]);
  const folders = ['普通媒体', '缺失场景', '白屏场景', '不存在'].map(name => path.join(staged, name));
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, folders, state: {} }));
}

async function runNodeGroup(report) {
  const result = await runProcess(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap'],
    process.env,
    path.join(report, 'node.stdout.log'),
    path.join(report, 'node.stderr.log'),
    300,
  );
  const output = await readFile(path.join(report, 'node.stdout.log'), 'utf8');
  const count = nodeTestCount(output);
  const passed = result.code === 0 && count > 0;
  const error = result.timedOut
    ? '超时，根因待定位（上限 300 秒）'
    : result.error?.message ?? (passed ? '' : `Node 测试退出码 ${result.code}，自动发现用例数 ${count ?? 0}`);
  return {
    id: 'node', label: 'Node 单元测试', status: result.timedOut ? 'timeout' : passed ? 'passed' : 'failed',
    elapsedMs: result.elapsedMs, count, timeoutSeconds: 300, command: result.command, pid: result.pid,
    error,
    stdoutTail: result.stdoutTail, stderrTail: result.stderrTail,
  };
}

async function runElectronCheck(check, report, runRoot, workRoot, dictionaryCache) {
  const missing = missingRequirements(check);
  if (missing.length) return { id: check.id, label: check.label, status: 'blocked', elapsedMs: 0,
    timeoutSeconds: check.timeoutSeconds, error: `依赖缺失：${missing.join(', ')}`, stdoutTail: '', stderrTail: '', logDirectory: report };
  const folder = path.join(runRoot, check.id);
  const evidenceFolder = path.join(report, 'Electron', check.id);
  await mkdir(folder, { recursive: true });
  await mkdir(evidenceFolder, { recursive: true });
  const evidence = path.join(folder, 'wallpaper.json');
  const settings = path.join(folder, 'Settings', 'Stilltime', 'settings.json');
  const env = {
    ...process.env,
    STILLTIME_DEV_DATA_ROOT: folder,
    STILLTIME_DEV_STEAM_ROOT: path.join(folder, 'NoSteam'),
    STILLTIME_DEV_CHECK: check.special === 'wallpaper' ? evidence : check.id,
    STILLTIME_DEV_WALLPAPER_FIXTURE_ONLY: check.id === 'wallpaper' ? '1' : '',
    STILLTIME_DEV_TRANSLATION_ASSETS: check.translationAssets ?? '',
    STILLTIME_DEV_DICTIONARY_CACHE: check.translationAssets ? dictionaryCache : '',
  };
  if (check.fixture === 'wallpaper') await prepareWallpaperFixtures(folder, settings);
  const flags = check.flags.map(value => `--${value}`);
  const result = await runProcess(electronPath, [...flags, source], env,
    path.join(evidenceFolder, 'stdout.log'), path.join(evidenceFolder, 'stderr.log'), check.timeoutSeconds, source, false);
  const stdout = await readFile(path.join(evidenceFolder, 'stdout.log'), 'utf8');
  const stderr = await readFile(path.join(evidenceFolder, 'stderr.log'), 'utf8');
  let specialPassed = true;
  if (check.special === 'wallpaper') {
    try { specialPassed = !(JSON.parse(await readFile(evidence, 'utf8'))).error; }
    catch { specialPassed = false; }
  }
  const passed = result.code === 0 && stdout.includes(check.success) && specialPassed;
  const evidenceError = await preserveQaEvidence(folder, evidenceFolder).then(() => null, error => error);
  const success = passed && !evidenceError;
  const ownerMarker = path.join(folder, '.reversewear-test-work.json');
  await writeFile(ownerMarker, JSON.stringify({ schema: 1, report: evidenceFolder, status: success ? 'passed' : 'failed', childPid: result.pid }), 'utf8');
  let cleanupWarning = '';
  if (success) {
    try { await removeOwnedWork(folder, workRoot); }
    catch (error) { cleanupWarning = `临时数据清理延期 · ${folder} · ${error.message}`; }
  }
  const blocked = Boolean(valueAfter('--setup-error'));
  const detail = result.timedOut
    ? `超时，根因待定位（上限 ${check.timeoutSeconds} 秒）`
    : result.error?.message ?? (blocked
      ? `依赖阻塞：${valueAfter('--setup-error')}`
      : evidenceError ? `验收证据复制失败：${evidenceError.stack ?? evidenceError.message}`
        : passed ? '' : `退出码 ${result.code}，${failureReason(stderr || stdout) || `未找到成功标记 ${check.success}`}`);
  return {
    id: check.id, label: check.label,
    status: result.timedOut ? 'timeout' : blocked ? 'blocked' : success ? 'passed' : 'failed',
    elapsedMs: result.elapsedMs, timeoutSeconds: check.timeoutSeconds, command: `${electronPath} ${flags.join(' ')} ${source}`, pid: result.pid,
    error: detail,
    stdoutTail: tail(stdout), stderrTail: tail(stderr), logDirectory: evidenceFolder, workDirectory: folder, cleanupWarning,
  };
}

async function preserveQaEvidence(dataRoot, evidenceRoot) {
  const screenshotFolders = new Set(['Screenshots', 'V17Screenshots', 'V18SuiteScreenshots']);
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const sourcePath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (screenshotFolders.has(entry.name)) await visit(sourcePath);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const isScreenshot = ['.png', '.jpg', '.jpeg'].includes(extension);
      const isResult = extension === '.json';
      if (!isScreenshot && !isResult) continue;
      const relative = path.relative(dataRoot, sourcePath);
      const destination = path.join(evidenceRoot, 'artifacts', relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(sourcePath, destination);
    }
  }
  await visit(dataRoot);
}

async function runSelected(selected, runOne) {
  const results = [];
  for (const check of selected) {
    try {
      results.push(await runOne(check));
    } catch (error) {
      results.push({ id: check.id, label: check.label, status: 'failed', elapsedMs: 0,
        timeoutSeconds: check.timeoutSeconds, error: error.stack ?? error.message,
        stdoutTail: '', stderrTail: '', logDirectory: '' });
    }
  }
  return results;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    validateRegistry();
    let emptyRejected = false;
    let unknownRejected = false;
    try { validateRegistry([]); } catch { emptyRejected = true; }
    try { selectByIds(['__unknown_test__']); } catch { unknownRejected = true; }
    if (!emptyRejected || !unknownRejected) throw new Error('登记表空值或未知项目自检失败。');
    let missingRejected = false;
    try { if (missingRequirements({ requires: [path.join(tmpdir(), `ReverseWear-Missing-${process.pid}`)] }).length) missingRejected = true; } catch {}
    const continued = await runSelected([{ id: 'synthetic-failure', label: '合成失败', timeoutSeconds: 5 }, { id: 'synthetic-pass', label: '失败后继续', timeoutSeconds: 5 }], async check => {
      if (check.id === 'synthetic-failure') throw new Error('SYNTHETIC_ASSERTION_FAILURE');
      return { id: check.id, label: check.label, status: 'passed' };
    });
    if (!missingRejected || continued.length !== 2 || continued[0].status !== 'failed' ||
        !continued[0].error.includes('SYNTHETIC_ASSERTION_FAILURE') || continued[1].status !== 'passed') {
      throw new Error('依赖缺失或失败后继续自检失败。');
    }
    const report = await mkdtemp(path.join(tmpdir(), 'ReverseWear-Runner-SelfTest-'));
    const failure = await runProcess(process.execPath, ['-e', "console.error('SYNTHETIC_ASSERTION_FAILURE'); process.exit(7)"], process.env,
      path.join(report, 'failure.stdout.log'), path.join(report, 'failure.stderr.log'), 5);
    const childPidFile = path.join(report, 'grandchild.pid');
    const spawnGrandchild = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const timeout = await runProcess(process.execPath, ['-e', spawnGrandchild], process.env,
      path.join(report, 'timeout.stdout.log'), path.join(report, 'timeout.stderr.log'), 1);
    const errorText = await readFile(path.join(report, 'failure.stderr.log'), 'utf8');
    if (failure.code !== 7 || !errorText.includes('SYNTHETIC_ASSERTION_FAILURE') || !timeout.timedOut || !timeout.pid || !timeout.command) {
      throw new Error(`运行器自检失败，失败退出码=${failure.code}，超时状态=${timeout.timedOut}，日志=${report}`);
    }
    const grandchildPid = Number((await readFile(childPidFile, 'utf8')).trim());
    await new Promise(resolve => setTimeout(resolve, 250));
    let grandchildAlive = true;
    try { process.kill(grandchildPid, 0); } catch { grandchildAlive = false; }
    if (grandchildAlive) throw new Error(`超时后仍有子进程存活：${grandchildPid}`);
    const compactError = `${failure.code} ${errorText}`;
    if (!compactError.includes('SYNTHETIC_ASSERTION_FAILURE')) throw new Error('失败原因摘要未保留原始错误。');
    const discovery = await mkdtemp(path.join(tmpdir(), 'ReverseWear-Node-Discovery-'));
    await mkdir(path.join(discovery, 'nested'), { recursive: true });
    await writeFile(path.join(discovery, 'one.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('one', () => assert.equal(1, 1));\n");
    await writeFile(path.join(discovery, 'nested', 'two.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('two', () => assert.equal(2, 2));\n");
    const discovered = await runProcess(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap'], process.env,
      path.join(report, 'discovery.stdout.log'), path.join(report, 'discovery.stderr.log'), 10, discovery);
    const discoveredOutput = await readFile(path.join(report, 'discovery.stdout.log'), 'utf8');
    if (discovered.code !== 0 || nodeTestCount(discoveredOutput) !== 2) throw new Error('Node 新增测试自动发现自检失败。');
    console.log(`运行器自检通过，登记表校验、失败后继续、依赖缺失、Node 自动发现及超时清理均已验证：${report}`);
    return 0;
  }
  const reportsRoot = path.resolve(valueAfter('--report-root') || path.resolve(source, '..', 'Test_Runs'));
  const profileRoot = path.join(process.env.LOCALAPPDATA || homedir(), 'ReverseWear', 'Development', 'CodexV23');
  const workRoot = path.resolve(valueAfter('--work-root') || path.join(profileRoot, 'TestWork'));
  const dictionaryCache = path.resolve(valueAfter('--dictionary-cache') || path.join(profileRoot, 'SharedCache', 'Dictionaries'));
  if (process.argv.includes('--storage-report') || process.argv.includes('--prune')) {
    return runStorageCommand({ reportsRoot, workRoot, dictionaryCache, apply: process.argv.includes('--apply'), prune: process.argv.includes('--prune') });
  }
  validateRegistry();
  const selected = await selectChecks();
  if (process.argv.includes('--list')) return 0;
  if (!selected.length) throw new Error('没有选中测试项目。');
  await mkdir(reportsRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = await mkdtemp(path.join(reportsRoot, `Run_${timestamp}_CodexV1-`));
  await mkdir(workRoot, { recursive: true });
  const runRoot = await mkdtemp(path.join(workRoot, 'Run_CodexV1-'));
  console.log(`测试日志目录：${report}`);
  const setupError = valueAfter('--setup-error');
  let position = 0;
  const results = await runSelected(selected, async check => {
    position += 1;
    console.log(`[${position}/${selected.length}] ${check.label} …`);
    if (check.kind === 'node') return runNodeGroup(report);
    if (setupError) return { id: check.id, label: check.label, status: 'blocked', elapsedMs: 0,
      timeoutSeconds: check.timeoutSeconds, error: `Electron 测试环境准备失败：${setupError}`,
      stdoutTail: '', stderrTail: '', logDirectory: report };
    if (!electronPath || !existsSync(electronPath)) return { id: check.id, label: check.label, status: 'blocked', elapsedMs: 0,
      timeoutSeconds: check.timeoutSeconds, error: electronPath ? `找不到 Electron：${electronPath}` : '缺少 --electron <electron.exe>',
      stdoutTail: '', stderrTail: '', logDirectory: report };
    return runElectronCheck(check, report, runRoot, workRoot, dictionaryCache);
  });
  await rmdir(runRoot).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  for (const result of results.filter(item => item.status !== 'passed')) {
    const folder = result.logDirectory || report;
    const stdoutPath = path.join(folder, result.id === 'node' ? 'node.stdout.log' : 'stdout.log');
    const stderrPath = path.join(folder, result.id === 'node' ? 'node.stderr.log' : 'stderr.log');
    const logs = await Promise.all([stdoutPath, stderrPath].map(file => readFile(file, 'utf8').catch(() => '')));
    const detail = [
      `项目：${result.label}`, `状态：${result.status}`, `原因：${result.error}`,
      `命令：${result.command ?? '未启动'}`, `PID：${result.pid ?? '未启动'}`,
      `超时上限：${result.timeoutSeconds} 秒`, `耗时：${result.elapsedMs} ms`,
      '完整标准输出：', logs[0], '完整错误输出：', logs[1],
    ].join('\n');
    result.logDirectory = folder;
    result.detailsPath = path.join(folder, `failure-details-${result.id}.txt`);
    await writeFile(result.detailsPath, detail, 'utf8');
  }
  const failed = results.some(result => result.status !== 'passed');
  const summary = [
    `V23 一键测试 · ${new Date().toISOString()}`,
    `结果：${failed ? '存在失败、超时或阻塞' : '全部通过'}`,
    ...results.map(result => result.status === 'passed'
      ? `运行成功无报错 · ${result.label}${result.count ? ` · ${result.count} 项` : ''} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`
    : `${result.status === 'timeout' ? '超时' : result.status === 'blocked' ? '阻塞' : '失败'} · ${result.label} · ${result.error} · 日志 ${result.logDirectory ?? report}${result.workDirectory ? ` · 现场 ${result.workDirectory}` : ''}`),
    `完整原始日志：${report}`,
    ...results.map(result => result.cleanupWarning).filter(Boolean),
  ].join('\n') + '\n';
  await writeFile(path.join(report, 'summary.txt'), summary, 'utf8');
  const failureLogs = results.filter(item => item.status !== 'passed').flatMap(item => [
    path.join(item.logDirectory ?? report, item.id === 'node' ? 'node.stdout.log' : 'stdout.log'),
    path.join(item.logDirectory ?? report, item.id === 'node' ? 'node.stderr.log' : 'stderr.log'),
    ...(item.detailsPath ? [item.detailsPath] : []),
  ]).filter(existsSync);
  const yamlReport = [
    'task: V23 一键测试', `status: ${results.some(item => item.status === 'blocked') ? 'blocked' : failed ? 'in_progress' : 'done'}`, `updated: ${new Date().toISOString().slice(0, 10)}`,
    'done:', ...results.filter(item => item.status === 'passed').map(item => `  - ${yaml(`运行成功无报错：${item.label}${item.count ? `，${item.count} 项` : ''}，${(item.elapsedMs / 1000).toFixed(1)} 秒`)}`),
    'todo:', ...results.filter(item => item.status !== 'passed').map(item => `  - ${yaml(`${item.status}：${item.label}，${item.error}`)}`),
    'blocked:', ...results.filter(item => item.status === 'blocked').map(item => `  - ${yaml(`${item.label}：${item.error}`)}`),
    'decisions:', `  - ${yaml(`日志目录：${report}`)}`,
    ...results.filter(item => item.status !== 'passed' && item.workDirectory).map(item => `  - ${yaml(`失败现场：${item.workDirectory}`)}`),
    ...results.map(item => item.cleanupWarning).filter(Boolean).map(warning => `  - ${yaml(warning)}`),
    'files:', `  - ${yaml(report)}`, ...failureLogs.map(file => `  - ${yaml(file)}`),
    'next_action: 查看失败项目的完整日志，成功结果摘要可直接核验。',
  ].join('\n') + '\n';
  await writeFile(path.join(report, 'report.yaml'), yamlReport, 'utf8');
  console.log(`\n${summary}`);
  return failed ? 1 : 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`测试启动失败：${error.stack ?? error.message}`);
  process.exitCode = 1;
});
