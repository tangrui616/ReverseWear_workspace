import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runNotesAutoDiscoveryCheck(win, { documentsDirectory, workbench, fixtureRoot }) {
  const notes = path.join(documentsDirectory, 'Notes');
  const title = 'V22 界面及布局更新说明';
  const file = path.join(notes, '更新说明.md');
  const source = '交付记录。\n\n# ' + title + '\n\n检索用标记。\n';
  const bodySelector = '#wb-notes [data-nw-body]';
  const listSelector = '#wb-notes [data-nw-list]';
  const run = expression => win.webContents.executeJavaScript(expression);
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  async function until(expression) {
    const end = Date.now() + 12_000;
    do {
      const result = await run(expression);
      if (result) return result;
      await delay(90);
    } while (Date.now() < end);
    const notesText = await run(query('#wb-notes') + '?.innerText');
    throw new Error('笔记验收超时：' + expression + '\n' + notesText);
  }
  const click = async selector => {
    await until('Boolean(' + query(selector) + ')');
    await run(query(selector) + '.click()');
  };
  const input = (selector, value) => run(`(() => {
    const field = ${query(selector)};
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const entry = label => `[...${query(listSelector)}.querySelectorAll('button.note-workspace__archive-open')]
      .find(button => button.textContent.includes(${JSON.stringify(label)}))`;
  const action = label => `[...${query('#wb-notes')}.querySelectorAll('button')]
      .find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled && button.getClientRects().length)`;
  const nav = view => click('[data-wb-nav="' + view + '"]');
  const save = async () => {
    await click('#wb-notes [data-nw-save]');
    await until(query('#wb-notes [data-nw-metadata]') + '.open');
    await click('#wb-notes [data-nw-metadata] [type=submit]');
    await until('!' + query('#wb-notes [data-nw-metadata]') + '.open');
  };

  await mkdir(notes, { recursive: true });
  await nav('notes');
  await until(query(listSelector) + '.textContent.includes("这里还没有笔记")');
  await writeFile(file, source, 'utf8');
  await until('Boolean(' + entry(title) + ')');
  const [original] = await workbench.listNotes({ kind: 'note' });
  assert.equal(original.title, title);
  assert.equal(await readFile(file, 'utf8'), source);
  await input('#wb-notes [data-nw-search]', '检索用标记');
  await until('Boolean(' + entry(title) + ')');
  await run(entry(title) + '.click()');
  await until(query(bodySelector) + '.value.includes("检索用标记")');
  await click('#wb-notes [data-nw-mode="source"]');
  const editorHeight = await run(`(() => {
    const body = ${query(bodySelector)};
    return { body: body.getBoundingClientRect().height, label: body.closest('label').getBoundingClientRect().height };
  })()`);
  assert.ok(editorHeight.body >= 250, `笔记正文编辑区应填充剩余高度：${JSON.stringify(editorHeight)}`);
  assert.ok(Math.abs(editorHeight.body - editorHeight.label) <= 4, `正文应填满编辑器行：${JSON.stringify(editorHeight)}`);
  await input(bodySelector, source + '工作台主动编辑。\n');
  await save();
  assert.equal((await workbench.listNotes({ kind: 'note' }))[0].id, original.id);
  assert.match(await readFile(file, 'utf8'), /工作台主动编辑/);

  const version = '# ' + title + '\n\n检索用标记。外部原子替换。\n';
  const managed = await readFile(file, 'utf8');
  const prefix = managed.slice(0, managed.indexOf('交付记录。'));
  assert.ok(prefix.startsWith('---'));
  const temporary = file + '.编辑器.tmp';
  await writeFile(temporary, prefix + version, 'utf8');
  await rename(temporary, file);
  await until(query(bodySelector) + '.value.includes("外部原子替换")');
  await writeFile(file, prefix + version, 'utf8');
  await writeFile(file, prefix + version, 'utf8');
  await until('Boolean(' + action('刷新文件夹') + ')');
  await run(action('刷新文件夹') + '.click()');
  assert.equal(await run(query('#wb-notes [data-nw-search]') + '.value'), '检索用标记');
  assert.equal(await run(query(listSelector) + '.querySelectorAll("button.note-workspace__archive-open").length'), 1);

  const draft = '# 独立草稿\n\n从工作台保留这段文字。\n';
  await input(bodySelector, draft);
  const externalConflict = prefix + '# ' + title + '\n\n检索用标记。磁盘冲突版本。\n';
  await writeFile(file, externalConflict, 'utf8');
  await until('Boolean(' + action('查看磁盘版本') + ')');
  assert.equal(await run(query(bodySelector) + '.value'), draft);
  await writeFile(path.join(fixtureRoot, 'notes-conflict.png'), (await win.webContents.capturePage()).toPNG());
  await run(action('查看磁盘版本') + '.click()');
  await until(query('#wb-notes') + '.innerText.includes("磁盘冲突版本") || [...document.querySelectorAll("#wb-notes dialog[open] textarea")].some(field => field.value.includes("磁盘冲突版本"))');
  await run(`(() => {
    const dialog = ${query('#wb-notes dialog[open]')};
    if (dialog) dialog.close();
  })()`);
  await until('Boolean(' + action('另存为新笔记') + ')');
  await run(action('另存为新笔记') + '.click()');
  await until(`window.stilltimeDesktop.workbench.listNotes({kind:'note', query:'从工作台保留这段文字'}).then(items => items.length === 1)`);
  assert.equal(await readFile(file, 'utf8'), externalConflict);
  const items = await workbench.listNotes({ kind: 'note' });
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === original.id).body.includes('磁盘冲突版本'), true);

  await nav('home');
  const fallback = path.join(notes, '无一级标题.md');
  await writeFile(fallback, '普通正文，异地更新。\n', 'utf8');
  await nav('notes');
  await input('#wb-notes [data-nw-search]', '无一级标题');
  await until('Boolean(' + entry('无一级标题') + ')');
  await run(entry('无一级标题') + '.click()');
  await until(query(bodySelector) + '.value.includes("异地更新")');
  const renameDraft = '# 改名前的草稿\n\n原路径移动时仍保留。\n';
  await input(bodySelector, renameDraft);
  await rename(fallback, path.join(notes, '外部改名后的文件.md'));
  await until(query('#wb-notes [data-nw-conflict-message]') + '.textContent.includes("移走或删除")');
  assert.equal(await run(query(bodySelector) + '.value'), renameDraft);
  await input('#wb-notes [data-nw-search]', '外部改名后的文件');
  await until('Boolean(' + entry('外部改名后的文件') + ')');
  await run(action('另存为新笔记') + '.click()');
  await until(`window.stilltimeDesktop.workbench.listNotes({kind:'note', query:'原路径移动时仍保留'}).then(items => items.length === 1)`);

  await win.webContents.reload();
  await until('Boolean(document.querySelector(\'.wb-nav [data-wb-nav="notes"]\'))');
  await nav('notes');
  await input('#wb-notes [data-nw-search]', '磁盘冲突版本');
  await until('Boolean(' + entry(title) + ')');
  await run(entry(title) + '.click()');
  await until(query(bodySelector) + '.value.includes("磁盘冲突版本")');

  await writeFile(path.join(fixtureRoot, 'notes-auto-discovery.png'), (await win.webContents.capturePage()).toPNG());

  const measure = `(() => {
    const all = [...document.querySelectorAll('[data-nw-search]')];
    const inputs = all.filter(field => field.getClientRects().length);
    return inputs.map(field => {
      const fieldBox = field.getBoundingClientRect();
      const sidebar = field.closest('[data-nw-archive]').getBoundingClientRect();
      return { left: fieldBox.left - sidebar.left, right: sidebar.right - fieldBox.right };
    });
  })()`;
  const margins = [];
  const restoreSize = win.getSize();
  for (const [width, height] of [[1320, 890], [720, 620]]) {
    win.setSize(width, height);
    await until('innerWidth <= ' + width);
    for (const mode of ['solid', 'glass']) {
      await run('document.documentElement.dataset.material = ' + JSON.stringify(mode));
      await nav('notes');
      for (const view of ['notes', 'memo']) {
        if (view === 'memo') await nav('plans');
        await until(measure + '.length === 1');
        const [gap] = await run(measure);
        assert.ok(gap.left >= 7 && gap.right >= 7, JSON.stringify({ width, mode, view, ...gap }));
        assert.ok(Math.abs(gap.left - gap.right) <= 2, JSON.stringify({ width, mode, view, ...gap }));
        margins.push({ width, mode, view, ...gap });
      }
    }
  }
  win.setSize(...restoreSize);
  await writeFile(path.join(fixtureRoot, 'notes-auto-discovery.json'), JSON.stringify({
    autoDiscovery: true, h1AndFileName: true, unchangedBeforeSave: true, originalFileNameAndId: true,
    bodySearch: true, manualRefreshKeepsSearch: true, repeatedEventsWithoutDuplicates: true, sameNameReplacement: true,
    showDiskVersion: true, conflictCopiesPreserved: true, externalRenameDraftPreserved: true, reentryAndReload: true,
    editorHeight, searchBounds: margins,
  }, null, 2));
  console.log('NOTES_V22_VERIFY_OK');
}
