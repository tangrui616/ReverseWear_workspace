import { commands, events } from '../ipc/contract.mjs';
import { APP } from './origins.mjs';

/** @typedef {import('../ipc/contract.mjs').CommandArgumentMap} CommandArgumentMap */
/** @typedef {import('../ipc/contract.mjs').CommandResultMap} CommandResultMap */
/** @typedef {import('../ipc/contract.mjs').EventPayloadMap} EventPayloadMap */
/** @typedef {Exclude<keyof CommandArgumentMap, 'suite:invoke'>} WorkbenchCommand */
/** @typedef {{url?: string, parent?: unknown} | null | undefined} SenderFrame */
/** @typedef {{sender: object, senderFrame: SenderFrame}} RequestEvent */
/** @typedef {{webContents: object}} SenderWindow */
/**
 * @typedef {<K extends WorkbenchCommand>(
 *   key: K,
 *   handler: (...args: CommandArgumentMap[K]) => Awaited<CommandResultMap[K]> | CommandResultMap[K]
 * ) => void} RegisterHandler
 */

/** @param {SenderFrame} frame */
function isTrustedMainFrame(frame) {
  if (!frame || frame.parent || typeof frame.url !== 'string') return false;
  try {
    const url = new URL(frame.url);
    return url.origin === APP && url.pathname === '/';
  } catch {
    return false;
  }
}

/**
 * @param {{handle: (channel: string, handler: (event: RequestEvent, ...args: unknown[]) => unknown) => void}} ipcMain
 * @param {{
 *   win: SenderWindow & {isDestroyed: () => boolean},
 *   getCaptureWindow: () => SenderWindow | null | undefined,
 *   serialize: (operation: () => unknown) => Promise<unknown>,
 * }} options
 */
export function createHandlerRegistry(ipcMain, { win, getCaptureWindow, serialize }) {
  const registered = new Set();

  /**
   * @template {WorkbenchCommand} K
   * @param {K} key
   * @param {(...args: CommandArgumentMap[K]) => Awaited<CommandResultMap[K]> | CommandResultMap[K]} handler
   */
  function register(key, handler) {
    const command = commands[key];
    if (!Object.hasOwn(commands, key) || command === commands['suite:invoke']) {
      throw new Error('Unknown workbench IPC: ' + key);
    }
    if (registered.has(key)) throw new Error('Duplicate workbench IPC: ' + key);
    ipcMain.handle(command.channel, (event, ...args) => {
      if (!command.capture && win.isDestroyed()) return;
      const frame = event.senderFrame;
      const fromMain = event.sender === win.webContents;
      if (!command.capture || fromMain) {
        if (!fromMain || !isTrustedMainFrame(frame)) {
          throw new Error(command.capture ? 'Unauthorized capture request' : 'Unauthorized desktop request');
        }
      } else {
        const capture = command.capturePopup && getCaptureWindow();
        if (!capture || event.sender !== capture.webContents || !frame || frame.parent || frame.url !== APP + '/capture.html') {
          throw new Error('Unauthorized capture request');
        }
      }
      const input = /** @type {CommandArgumentMap[K]} */ (args);
      return command.write ? serialize(() => handler(...input)) : handler(...input);
    });
    registered.add(key);
  }

  function assertComplete() {
    const missing = Object.keys(commands).filter(key => key !== 'suite:invoke' && !registered.has(key));
    if (missing.length) throw new Error('Missing workbench IPC: ' + missing.join(', '));
  }

  return { register, assertComplete };
}

/**
 * @template {keyof EventPayloadMap} K
 * @param {{send: (channel: string, ...args: unknown[]) => void}} target
 * @param {K} key
 * @param {K extends 'suite:changed' ? [payload?: EventPayloadMap[K]] : [payload: EventPayloadMap[K]]} payload
 */
export function sendEvent(target, key, ...payload) {
  if (!Object.hasOwn(events, key)) throw new Error('Unknown workbench event: ' + key);
  target.send(events[key].channel, ...payload);
}
