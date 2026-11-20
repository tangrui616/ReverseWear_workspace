import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.dirname(fileURLToPath(import.meta.url));
const localElectron = path.join(project, '.electron-45');
const electronDist = process.env.REVERSEWEAR_ELECTRON_DIST
  ? path.resolve(process.env.REVERSEWEAR_ELECTRON_DIST)
  : existsSync(path.join(localElectron, 'electron.exe'))
    ? localElectron
    : path.join(project, 'node_modules', 'electron', 'dist');
const [action, output, buildFormat = 'portable'] = process.argv.slice(2);

function ensureWindowsBridge() {
  const source = path.join(project, 'desktop_suite', 'WindowsBridge.cs');
  const destination = path.join(project, '.suite-native', 'WindowsBridge.exe');
  const compiler = process.env.WINDOWS_BRIDGE_CSC || path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(source)) throw new Error(`Windows helper source is missing: ${source}`);
  if (!existsSync(compiler)) throw new Error(`C# compiler is missing: ${compiler}. Install the Windows .NET Framework 4.x developer tools or set WINDOWS_BRIDGE_CSC.`);
  if (existsSync(destination) && statSync(destination).mtimeMs >= statSync(source).mtimeMs) {
    process.env.REVERSEWEAR_WINDOWS_BRIDGE_PATH = destination;
    return destination;
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  const framework = path.dirname(compiler);
  const references = [
    path.join(framework, 'System.Windows.Forms.dll'),
    path.join(framework, 'System.Web.Extensions.dll'),
    path.join(framework, 'WPF', 'UIAutomationClient.dll'),
    path.join(framework, 'WPF', 'UIAutomationTypes.dll'),
  ];
  for (const reference of references) {
    if (!existsSync(reference)) throw new Error(`Windows helper reference is missing: ${reference}`);
  }
  execFileSync(compiler, [
    '/nologo', '/platform:x64', '/target:winexe', '/optimize+', `/out:${destination}`,
    ...references.map(reference => `/reference:${reference}`), source,
  ], { cwd: project, stdio: 'inherit', windowsHide: true });
  process.env.REVERSEWEAR_WINDOWS_BRIDGE_PATH = destination;
  return destination;
}

function checkApplicationSyntax() {
  execFileSync(process.execPath, [path.join(project, 'ipc', 'generate-preloads.mjs'), '--check'],
    { cwd: project, stdio: 'inherit', windowsHide: true });
  const sources = ['main.mjs', 'preload.cjs', 'capture-preload.cjs', 'suite-preload.cjs', 'desktop_articles.mjs',
    'workbench-store.mjs', 'dist/workbench.mjs', 'dist/article-inbox.mjs', 'dist/desktop-suite/suite.mjs',
    'qa/portable-verification.mjs', 'qa/development-verification.mjs', 'ipc/contract.mjs',
    ...readdirSync(path.join(project, 'main')).filter(name => name.endsWith('.mjs'))
      .map(name => path.join('main', name)),
    ...readdirSync(path.join(project, 'desktop_suite')).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .map(name => path.join('desktop_suite', name))];
  for (const file of sources) execFileSync(process.execPath, ['--check', path.join(project, file)],
    { cwd: project, stdio: 'inherit', windowsHide: true });
}

if (action === 'start') {
  checkApplicationSyntax();
  ensureWindowsBridge();
  const electron = path.join(electronDist, 'electron.exe');
  if (!existsSync(electron)) throw new Error(`Electron 不存在：${electron}。请先运行 npm ci。`);
  const child = spawn(electron, [project, ...process.argv.slice(3)], { cwd: project, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else if (action === 'verify') {
  checkApplicationSyntax();
  ensureWindowsBridge();
  const electron = path.join(electronDist, 'electron.exe');
  if (!existsSync(electron)) throw new Error(`Electron 不存在：${electron}。请先运行 npm ci。`);
  execFileSync(process.execPath, [path.join(project, 'qa', 'verify-v91.mjs'), ...process.argv.slice(3)], {
    cwd: project, stdio: 'inherit', env: { ...process.env, REVERSEWEAR_QA_ELECTRON: electron },
  });
} else if (action === 'build') {
  if (!['portable', 'directory'].includes(buildFormat)) {
    throw new Error(`Unsupported build format: ${buildFormat}`);
  }
  checkApplicationSyntax();
  ensureWindowsBridge();
  const tools = path.join(project, '.toolset');
  const nsis = path.join(tools, 'nsis@1.2.1', 'nsis-bundle');
  if (buildFormat === 'portable' && existsSync(nsis)) {
    process.env.ELECTRON_BUILDER_NSIS_DIR = nsis;
    process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsis;
    process.env.ELECTRON_BUILDER_7ZIP_PATH = path.join(tools, '7zip@1.0.0', '7zip', 'bin', '7za.exe');
    process.env.ELECTRON_BUILDER_RCEDIT_PATH = path.join(tools, 'rcedit');
  }
  const { build, Platform } = await import('electron-builder');
  const { Arch } = await import('builder-util');
  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget(buildFormat === 'directory' ? 'dir' : 'portable', Arch.x64),
    config: {
      electronDist,
      directories: { output: output ? path.resolve(output) : 'release' },
    },
  });
  if (buildFormat === 'directory') {
    console.log(`Directory build executable: ${path.resolve(output || 'release', 'win-unpacked', 'ReverseWear.exe')}`);
  }
} else {
  throw new Error('请使用 npm start 或 npm run build。');
}
