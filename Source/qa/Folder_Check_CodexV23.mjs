import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Verify real folders, external discovery, note placement and moves in an isolated profile. */
export async function runFolderCheck(win, { workbench, documentsDirectory, fixtureRoot } = {}) {
  assert.ok(workbench, '文件夹验收需要 workbench API。');
  assert.ok(documentsDirectory, '文件夹验收需要隔离 Documents 目录。');
  const marker = `CodexV23-${randomUUID().slice(0, 8)}`;
  const notesRoot = path.join(documentsDirectory, 'Notes');
  const externalName = `外部空目录-${marker}`;
  const nestedName = `嵌套目录-${marker}`;
  const destinationName = `移动目标-${marker}`;
  const externalPath = path.join(notesRoot, externalName);
  const nestedPath = `${externalName}/${nestedName}`;
  const destinationPath = `${externalName}/${destinationName}`;
  const run = expression => win.webContents.executeJavaScript(expression);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;

  async function until(expression, label, timeout = 12_000) {
    const deadline = Date.now() + timeout;
    do {
      const value = await run(expression).catch(() => false);
      if (value) return value;
      await delay(80);
    } while (Date.now() < deadline);
    throw new Error(`真实文件夹验收超时：${label}`);
  }
  async function click(selector) {
    await until(`Boolean(${q(selector)})`, `找到 ${selector}`);
    await run(`${q(selector)}.click()`);
  }
  async function rightClickExpression(expression, label) {
    await until(`Boolean(${expression})`, `找到右键目标 ${label}`);
    await run(`(() => { const target = ${expression}; target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 120, clientY: 120 })); })()`);
  }
  async function fill(selector, value) {
    await until(`Boolean(${q(selector)})`, `找到输入框 ${selector}`);
    await run(`(() => { const field = ${q(selector)}; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  const notePanel = '#wb-notes';
  const list = `${notePanel} [data-nw-list]`;
  const folderButton = label => ` [...${q(list)}.querySelectorAll('.note-workspace__folder')].find(node => node.textContent.trim() === ${JSON.stringify(label)})`;
  const noteEntry = title => ` [...${q(list)}.querySelectorAll('.note-workspace__archive-open')].find(node => node.textContent.includes(${JSON.stringify(title)}))`;

  await mkdir(notesRoot, { recursive: true });
  await click('[data-wb-nav="notes"]');
  await until(`Boolean(${q(list)})`, '笔记页面加载');

  // Subscribe before creating an external empty directory, then require the watcher event quickly.
  await run(`(() => {
    window.__folderCheckIndexEvent = null;
    window.__folderCheckIndexOff?.();
    window.__folderCheckIndexOff = window.stilltimeDesktop.onIndexChanged?.(categories => {
      if (Array.isArray(categories) && categories.some(value => ['notes', 'memos', 'links', 'linknotes'].includes(value))) {
        window.__folderCheckIndexEvent = { categories, at: performance.now() };
      }
    });
  })()`);
  const eventStarted = await run('performance.now()');
  await mkdir(externalPath);
  const indexEvent = await until('window.__folderCheckIndexEvent', '外部空目录触发 index:changed', 2_000);
  const eventLatencyMs = indexEvent.at - eventStarted;
  assert.ok(eventLatencyMs <= 2_000, `外部目录应在 2 秒内触发索引事件：${eventLatencyMs}ms`);
  await until(`${q(list)}.textContent.includes(${JSON.stringify(externalName)})`, '外部空目录出现在工作台列表', 2_000);

  // Create a nested folder through the note list's actual context menu/dialog.
  await until(`Boolean(${folderButton(externalName)})`, '定位外部目录行');
  await run(`${folderButton(externalName)}.click()`);
  await rightClickExpression(folderButton(externalName), '外部文件夹');
  const folderDialog = `${notePanel} dialog.note-workspace__folder-dialog`;
  await until(`${q(folderDialog)}?.open`, '右键文件夹菜单打开');
  await run(`(() => { const dialog = ${q(folderDialog)}; const select = dialog.querySelector('select'); select.value = '新建文件夹'; select.dispatchEvent(new Event('change')); const input = dialog.querySelector('input'); input.value = ${JSON.stringify(nestedName)}; input.dispatchEvent(new Event('input', { bubbles: true })); dialog.querySelector('button[type="submit"]').click(); })()`);
  await until(`window.stilltimeDesktop.workbench.listFolders({scope:'notes'}).then(items => items.includes(${JSON.stringify(nestedPath)}))`, '嵌套目录已由真实 UI 创建');
  assert.equal((await stat(path.join(notesRoot, ...nestedPath.split('/')))).isDirectory(), true, '嵌套文件夹必须真实存在于磁盘。');

  // Save a note through the editor while the created nested folder is selected.
  const title = '文件夹验收笔记';
  const bodyText = `# ${title}\n\n真实目录保存与移动验收。\n`;
  await click(`${notePanel} [data-nw-new]`);
  await fill(`${notePanel} [data-nw-body]`, bodyText);
  await click(`${notePanel} [data-nw-save]`);
  const metadata = `${notePanel} [data-nw-metadata]`;
  await until(`${q(metadata)}.open`, '保存笔记信息弹窗');
  await click(`${metadata} [type="submit"]`);
  await until(`!${q(metadata)}.open && Boolean(${noteEntry(title)})`, '笔记保存并显示在目录');
  let saved = (await workbench.listNotes({ kind: 'note', query: title })).find(item => item.title === title);
  assert.ok(saved, '保存的笔记可通过索引找到。');
  assert.equal(saved.folderPath, nestedPath, '新笔记应保存在所选嵌套文件夹。');
  const originalId = saved.id;
  const sourceFile = path.join(notesRoot, ...saved.path.split('/'));
  assert.match(await readFile(sourceFile, 'utf8'), /真实目录保存与移动验收/);

  // Prepare another real folder and move the entry with the same UI right-click flow.
  await workbench.createFolder({ scope: 'notes', parentPath: externalName, name: destinationName });
  await rightClickExpression(`${noteEntry(title)}.closest('.note-workspace__archive-item')`, '笔记条目');
  await until(`${q(folderDialog)}?.open`, '笔记右键菜单打开');
  await run(`(() => { const dialog = ${q(folderDialog)}; const selects = dialog.querySelectorAll('select'); const action = selects[0]; action.value = '移动到'; action.dispatchEvent(new Event('change')); const destination = selects[1]; destination.value = ${JSON.stringify(destinationPath)}; dialog.querySelector('button[type="submit"]').click(); })()`);
  await until(`window.stilltimeDesktop.workbench.listNotes({kind:'note',query:${JSON.stringify(title)}}).then(items => items.some(item => item.title === ${JSON.stringify(title)} && item.folderPath === ${JSON.stringify(destinationPath)}))`, '移动后的笔记路径更新');
  saved = (await workbench.listNotes({ kind: 'note', query: title })).find(item => item.title === title);
  assert.equal(saved.folderPath, destinationPath);
  assert.equal(saved.id, originalId, '移动后保持记录身份。');
  const movedFile = path.join(notesRoot, ...saved.path.split('/'));
  assert.match(await readFile(movedFile, 'utf8'), /真实目录保存与移动验收/);
  await assert.rejects(readFile(sourceFile, 'utf8'), { code: 'ENOENT' });
  await until(`Boolean(${folderButton(externalName)}.closest('.note-workspace__folder-row')?.querySelector('.note-workspace__folder-toggle'))`, '找到外部目录展开按钮');
  await run(`if (!${folderButton(destinationName)}) ${folderButton(externalName)}.closest('.note-workspace__folder-row').querySelector('.note-workspace__folder-toggle').click()`);
  await until(`Boolean(${folderButton(destinationName)})`, '移动目标文件夹显示在树中');
  await run(`${folderButton(destinationName)}.click()`);
  await until(`Boolean(${noteEntry(title)})`, '移动后列表能重开笔记');
  await run(`${noteEntry(title)}.click()`);
  await until(`${q(`${notePanel} [data-nw-body]`)}.value.includes('真实目录保存与移动验收')`, '移动后的笔记可重新打开');

  // Exercise all folder scopes and assert that each is persisted as a real directory.
  const memoFolder = `备忘录目录-${marker}`;
  const linksFolder = `收藏目录-${marker}`;
  const linkNotesFolder = `关联笔记目录-${marker}`;
  await workbench.createFolder({ scope: 'memos', name: memoFolder });
  await workbench.createFolder({ scope: 'links', name: linksFolder });
  const linkResult = await workbench.saveLink({ url: `https://${marker.toLowerCase()}.example.invalid/${marker}`, title: marker });
  const linkId = linkResult.item.id;
  await workbench.createFolder({ scope: 'link-notes', linkId, name: linkNotesFolder });
  for (const relative of [
    ['Memos', memoFolder], ['Links', linksFolder], ['LinkNotes', linkId, linkNotesFolder],
  ]) assert.equal((await stat(path.join(documentsDirectory, ...relative))).isDirectory(), true, `${relative.join('/')} 应是磁盘目录。`);
  assert.ok((await workbench.listFolders({ scope: 'memos' })).includes(memoFolder));
  assert.ok((await workbench.listFolders({ scope: 'links' })).includes(linksFolder));
  assert.ok((await workbench.listFolders({ scope: 'link-notes', linkId })).includes(linkNotesFolder));

  await run('window.__folderCheckIndexOff?.(); delete window.__folderCheckIndexOff; delete window.__folderCheckIndexEvent;');
  if (fixtureRoot) {
    await mkdir(fixtureRoot, { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(fixtureRoot, 'Folder_Check_CodexV23.json'), JSON.stringify({ marker, eventLatencyMs, eventCategories: indexEvent.categories, externalEmptyFolderDiscovered: true, nestedFolderCreatedThroughContextMenu: true, noteSavedToSelectedDirectory: saved.folderPath === destinationPath, noteMovedAndReopened: true, memoLinksAndLinkNotesFoldersPersisted: true }, null, 2)));
  }
  return { eventLatencyMs, eventCategories: indexEvent.categories, noteId: saved.id, movedPath: saved.path, memoFolder, linksFolder, linkNotesFolder };
}
