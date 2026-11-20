import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerFile = fileURLToPath(new URL('./desktop_document_worker.mjs', import.meta.url));
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 10000;

export function renderImportedDocument(name, contents) {
  const extension = String(name).toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!['.md', '.markdown', '.docx'].includes(extension)) {
    return Promise.reject(new Error('只支持在工作台阅读 Markdown 和 DOCX 文件。'));
  }
  const bytes = Buffer.from(contents);
  if (bytes.length > MAX_INPUT_BYTES) return Promise.reject(new Error('文件超过 32 MiB，无法在工作台中阅读。'));

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
      workerData: { extension, contents: bytes },
    });
    let settled = false;
    const finish = (error, html) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_BYTES) reject(new Error('文档转换结果过大，无法在工作台中显示。'));
      else resolve(html);
    };
    const timeout = setTimeout(() => finish(new Error('文档转换超时，请在文件夹中打开此文件。')), WORKER_TIMEOUT_MS);
    worker.once('message', result => {
      if (!result?.ok) finish(new Error(result?.error || '文档转换失败。'));
      else finish(null, result.html);
    });
    worker.once('error', error => finish(new Error(`文档转换失败：${error.message}`)));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(new Error('文档转换进程意外结束。'));
    });
  });
}
