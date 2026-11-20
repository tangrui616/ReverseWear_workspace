import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_DATA_ROOT = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || process.cwd(), '.local', 'share'), 'ReverseWear', 'Workbench');

export function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export function syncDirectoryWarning(folder, environment = process.env) {
  const known = [environment.OneDrive, environment.OneDriveConsumer, environment.OneDriveCommercial]
    .filter(item => item && path.isAbsolute(item));
  const named = folder.split(/[\\/]/).some(part => /^(onedrive|dropbox|google drive|icloud drive|百度网盘|坚果云)(?:$|[ -])/i.test(part));
  return named || known.some(root => isWithin(root, folder))
    ? '这个目录可能由同步软件管理。文档、历史和设置可能被同步到其他设备。'
    : '';
}

export async function verifyDataRoot(selection) {
  if (typeof selection !== 'string' || !path.isAbsolute(selection) || selection.startsWith('\\\\')) {
    throw new Error('请选择可读写的本地目录。');
  }
  const root = await realpath(selection);
  if (root === path.parse(root).root || (await lstat(selection)).isSymbolicLink()) throw new Error('请选择具体的数据文件夹。');
  const directories = ['Documents', 'Documents/Notes', 'Settings', 'Settings/Stilltime', 'Runtime', 'Runtime/Stilltime', 'Runtime/Stilltime/Chromium', 'AI-Mirror'];
  for (const name of directories) {
    const candidate = path.join(root, name);
    const info = await lstat(candidate).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(candidate, await realpath(candidate))) {
      throw new Error(`数据子目录结构异常：${candidate}`);
    }
  }
  for (const name of ['settings.json', 'appearance.json', 'risk-preferences.json']) {
    const file = path.join(root, 'Settings', 'Stilltime', name);
    const info = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`配置文件路径异常：${file}`);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        (name === 'settings.json' && parsed.schemaVersion !== 1)) throw new Error(`无法使用配置：${file}`);
  }
  for (const folder of [root, ...directories.map(name => path.join(root, name))]) {
    const probe = path.join(folder, '.reversewear-check-' + randomUUID());
    const handle = await open(probe, 'wx').catch(error => {
      if (error.code === 'ENOENT' && folder !== root) return null;
      throw error;
    });
    if (!handle) continue;
    await handle.close();
    await unlink(probe);
  }
  return { root, warning: syncDirectoryWarning(root) };
}

export async function loadDataPointer(file) {
  try {
    const { root } = JSON.parse(await readFile(file, 'utf8'));
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('工作台启动配置中的数据路径无效。');
    return root;
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_DATA_ROOT;
    throw error;
  }
}

function sameLocalPath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

function parsePointer(contents) {
  const pointer = JSON.parse(contents);
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
    throw new Error('工作台启动配置中的数据路径无效。');
  }
  if (typeof pointer.root !== 'string' || !path.isAbsolute(pointer.root)) {
    throw new Error('工作台启动配置中的数据路径无效。');
  }
  return pointer;
}

async function readPointer(file) {
  try {
    return parsePointer(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function portableNotesExists(portableDirectory) {
  const documents = path.join(portableDirectory, 'Documents');
  const notes = path.join(documents, 'Notes');
  const documentsInfo = await lstat(documents).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!documentsInfo) return false;
  if (!documentsInfo.isDirectory() || documentsInfo.isSymbolicLink()) {
    throw new Error(`便携数据目录结构异常：${documents}`);
  }
  const notesInfo = await lstat(notes).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!notesInfo) return false;
  if (!notesInfo.isDirectory() || notesInfo.isSymbolicLink()) {
    throw new Error(`便携笔记目录结构异常：${notes}`);
  }
  const actualDocuments = await realpath(documents);
  const actualNotes = await realpath(notes);
  if (!sameLocalPath(actualDocuments, documents) || !sameLocalPath(actualNotes, notes)) {
    throw new Error(`便携笔记目录不能指向其他位置：${notes}`);
  }
  return true;
}

export async function resolveDataRoot({
  pointerFile,
  portableDirectory,
  defaultDataRoot = DEFAULT_DATA_ROOT,
} = {}) {
  if (!portableDirectory) {
    const pointer = await readPointer(pointerFile);
    if (!pointer && defaultDataRoot === DEFAULT_DATA_ROOT) await mkdir(defaultDataRoot, { recursive: true });
    const verified = await verifyDataRoot(pointer?.root ?? defaultDataRoot);
    return { ...verified, portable: false, source: 'legacy' };
  }

  const portable = await realpath(portableDirectory);
  let pointer;
  let pointerError;
  try { pointer = await readPointer(pointerFile); }
  catch (error) { pointerError = error; }
  const storedPointer = pointer ?? { root: defaultDataRoot };
  const overrides = storedPointer.portableOverrides && typeof storedPointer.portableOverrides === 'object'
    ? storedPointer.portableOverrides : {};
  const matchingOverride = Object.entries(overrides)
    .filter(([directory]) => path.isAbsolute(directory) && sameLocalPath(directory, portable)).at(-1);
  if (matchingOverride) {
    const verified = await verifyDataRoot(matchingOverride[1]);
    return { ...verified, portable: false, source: 'override' };
  }

  let hasPortableNotes = false;
  try { hasPortableNotes = await portableNotesExists(portable); }
  catch (error) { throw pointerError ?? error; }
  if (hasPortableNotes) {
    const verified = await verifyDataRoot(portable);
    return { ...verified, portable: true, source: 'portable' };
  }
  if (pointerError) throw pointerError;
  const root = storedPointer.root || defaultDataRoot;
  if (!pointer && root === DEFAULT_DATA_ROOT) await mkdir(root, { recursive: true });
  const verified = await verifyDataRoot(root);
  return { ...verified, portable: false, source: pointer?.root ? 'legacy' : 'default' };
}

export async function saveDataPointer(file, root, {
  portableDirectory,
  defaultDataRoot = DEFAULT_DATA_ROOT,
} = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const pending = file + '.' + randomUUID() + '.pending';
  let pointer;
  if (portableDirectory) {
    let previous;
    try {
      previous = await readPointer(file);
    } catch {
      previous = null;
    }
    pointer = previous ?? { root: defaultDataRoot };
    const portable = await realpath(portableDirectory);
    const selectedRoot = await realpath(root);
    const portableOverrides = pointer.portableOverrides && typeof pointer.portableOverrides === 'object'
      && !Array.isArray(pointer.portableOverrides) ? { ...pointer.portableOverrides } : {};
    for (const directory of Object.keys(portableOverrides)) {
      if (sameLocalPath(directory, portable)) delete portableOverrides[directory];
    }
    if (!sameLocalPath(selectedRoot, portable) || !await portableNotesExists(portable)) {
      portableOverrides[portable] = selectedRoot;
    }
    pointer = { ...pointer, portableOverrides };
  } else {
    let previous;
    try { previous = await readPointer(file); }
    catch { previous = null; }
    pointer = { ...previous, root };
  }
  await writeFile(pending, JSON.stringify(pointer) + '\n', { flag: 'wx' });
  try {
    await rename(pending, file);
  } finally {
    await unlink(pending).catch(() => {});
  }
}
