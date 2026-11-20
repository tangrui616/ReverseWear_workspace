import { spawn } from 'node:child_process';
import { access, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./desktop_translation_worker.py', import.meta.url));
const defaultPython = [
  process.env.STILLTIME_PYTHON,
].filter(Boolean);

function isDirectory(value) {
  return stat(value).then(result => result.isDirectory(), () => false);
}

async function findPython(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the next known interpreter */ }
  }
  throw new Error('找不到本地 Python 运行时。');
}

export function createOfflineTranslator({ modelsDirectory = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || process.cwd(), '.local', 'share'), 'ReverseWear', 'Translation', 'Models'), runtimeDirectory = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || process.cwd(), '.local', 'share'), 'ReverseWear', 'Translation', 'Runtime'), pythonCandidates = defaultPython, workerFile, llamaExecutable, requestTimeoutMs = 10 * 60 * 1000 } = {}) {
  llamaExecutable ??= path.join(runtimeDirectory, 'llama-b12377-vulkan', 'llama-completion.exe');
  const pythonPackages = path.join(runtimeDirectory, 'python311');
  const extractedDirectory = path.join(runtimeDirectory, 'argos-models');
  let child;
  let pending = [];
  let buffered = '';
  let sequence = 0;
  let startPromise;
  let extractionPromise;
  let closed = false;

  async function resolveWorker() {
    if (workerFile) return workerFile;
    const candidates = process.resourcesPath
      ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop_translation_worker.py'), workerPath]
      : [workerPath];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* try the next packaged location */ }
    }
    throw new Error('找不到本地翻译引擎程序。');
  }

  async function prepareArgosModels() {
    if (extractionPromise) return extractionPromise;
    extractionPromise = prepareModelsOnce();
    try { await extractionPromise; } finally { extractionPromise = undefined; }
  }

  async function prepareModelsOnce() {
    await mkdir(extractedDirectory, { recursive: true });
    for (const [direction, file] of [['en-zh', 'translate-en_zh-1_9.argosmodel'], ['zh-en', 'translate-zh_en-1_9.argosmodel']]) {
      const source = path.join(modelsDirectory, file);
      const model = path.join(extractedDirectory, direction);
      if (await isDirectory(path.join(model, 'model'))) continue;
      try { await access(source); } catch { continue; }
      const temporary = `${model}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(path.dirname(model), { recursive: true });
      const unpack = spawn(await findPython(pythonCandidates), ['-c',
        'import pathlib,sys,zipfile\nsrc=pathlib.Path(sys.argv[1]); dst=pathlib.Path(sys.argv[2]); dst.mkdir(parents=True,exist_ok=True)\nwith zipfile.ZipFile(src) as archive:\n root=dst.resolve()\n for item in archive.infolist():\n  out=(dst/item.filename).resolve()\n  if root not in out.parents and out != root: raise RuntimeError("Unsafe model archive member")\n archive.extractall(dst)', source, temporary], { windowsHide: true });
      const result = await new Promise((resolve, reject) => {
        unpack.once('error', reject);
        unpack.once('close', code => code === 0 ? resolve() : reject(new Error(`Argos 模型解包失败 (${code})`)));
      });
      await result;
      const nested = path.join(temporary, `translate-${direction.replace('-', '_')}-1_9`);
      if (await isDirectory(nested)) {
        await rename(nested, model);
      } else {
        await rename(temporary, model);
      }
    }
  }

  async function start() {
    if (closed) throw new Error('本地翻译引擎已经关闭。');
    if (child && child.exitCode === null) return;
    if (startPromise) return startPromise;
    startPromise = startWorker();
    try { await startPromise; } finally { startPromise = undefined; }
  }

  async function startWorker() {
    const python = await findPython(pythonCandidates);
    const args = ['-u', await resolveWorker(), '--models', modelsDirectory, '--argos', extractedDirectory, '--packages', pythonPackages, '--llama', llamaExecutable];
    child = spawn(python, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: pythonPackages,
      TRANSFORMERS_OFFLINE: '1',
    } });
    buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        const index = pending.findIndex(item => item.id === response.id);
        if (index >= 0) {
          const [item] = pending.splice(index, 1);
          clearTimeout(item.timer);
          item.resolve(response);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', message => { child.lastError = `${child.lastError ?? ''}${message}`.slice(-4000); });
    child.once('error', error => {
      const detail = new Error(`无法启动本地翻译进程：${error.message}`);
      for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(detail); }
      child = undefined;
    });
    child.once('close', code => {
      const error = new Error(`本地翻译进程已退出 (${code})。${child?.lastError ?? ''}`);
      for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(error); }
      child = undefined;
    });
  }

  async function request(operation, payload = {}) {
    await start();
    const id = ++sequence;
    const response = new Promise((resolve, reject) => {
      const item = { id, resolve, reject, timer: setTimeout(() => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error('本地翻译超时。模型首次加载可能需要较长时间，请稍后重试。'));
      }, requestTimeoutMs) };
      pending.push(item);
    });
    child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, error => {
      if (!error) return;
      const index = pending.findIndex(item => item.id === id);
      if (index >= 0) {
        const [item] = pending.splice(index, 1);
        clearTimeout(item.timer);
        item.reject(new Error(`无法发送本地翻译请求：${error.message}`));
      }
    });
    const result = await response;
    if (!result.ok) throw new Error(result.error || '本地翻译失败。');
    return result.value;
  }

  return {
    async status() {
      await prepareArgosModels();
      return request('status');
    },
    async translate({ text, direction, engine = 'argos' }) {
      const value = String(text ?? '').trim();
      if (!value) throw new Error('请输入需要翻译的内容。');
      if (value.length > 12000) throw new Error('单次翻译最多支持 12,000 个字符。');
      await prepareArgosModels();
      return request('translate', { text: value, direction, engine });
    },
    close() {
      closed = true;
      for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(new Error('本地翻译引擎已关闭。')); }
      if (child && child.exitCode === null) child.kill();
    },
  };
}
