import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runTemplatesCheck(win, { documentsDirectory }) {
  const run = expression => win.webContents.executeJavaScript(expression, true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => run(el(selector) + '?.click()');
  const setValue = (selector, value) => run(`(() => {
    const field = ${el(selector)};
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  async function until(expression, label, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await run(expression)) return;
      await delay(80);
    }
    throw new Error(`V23 模板独立验收超时：${label}`);
  }
  const nav = view => click(`[data-wb-nav="${view}"]`);
  const lifeApi = 'window.stilltimeDesktop.life';
  const marker = Date.now().toString(36);
  const initialTitle = `V23 模板独立验收 ${marker}`;
  const editedTitle = `${initialTitle}（已编辑）`;
  const noteTitle = `V23 模板插入验收 ${marker}`;
  const noteDirectory = path.join(documentsDirectory, 'Notes');
  const noteFile = path.join(noteDirectory, `${noteTitle}.md`);
  {
    await nav('settings');
    await until(`${el('#wb-settings .wb-settings__workspace')}.textContent.includes('Markdown 模板')`, '设置模板管理页');
    await until(`${lifeApi}.list({ kind: 'template' }).then(items => Array.isArray(items))`, '模板列表加载');
    await click('#wb-settings [data-template-new]');
    await setValue('#wb-settings [data-template-title]', initialTitle);
    const initialBody = '## 初次记录\n\n初始模板正文。';
    await setValue('#wb-settings [data-template-body]', initialBody);
    await click('#wb-settings [data-template-form] [type="submit"]');
    await until(`${el('#wb-settings [data-template-status]')}.textContent.includes('已保存')`, '模板首次保存');

    let created = await run(`${lifeApi}.list({ kind: 'template' }).then(items => items.find(item => item.title === ${JSON.stringify(initialTitle)}))`);
    assert.ok(created, '应通过生活与思考数据服务读取已创建的模板');
    assert.equal(created.fields?.templateBody, initialBody);
    let templateFile = path.resolve(documentsDirectory, created.relativePath);
    assert.ok(templateFile.startsWith(path.resolve(documentsDirectory) + path.sep), '模板文件应位于当前隔离数据根内');
    let markdown = await readFile(templateFile, 'utf8');
    assert.match(markdown, new RegExp(`title: .*${marker}`));
    assert.ok(markdown.endsWith(initialBody), '模板 Markdown 文件应写入完整正文');

    await run(`[...document.querySelectorAll('#wb-settings .wb-settings__template-item')].find(button => button.textContent.includes(${JSON.stringify(initialTitle)})).click()`);
    await until(`${el('#wb-settings [data-template-title]')}.value === ${JSON.stringify(initialTitle)}`, '选中已创建模板');
    await setValue('#wb-settings [data-template-title]', editedTitle);
    const editedBody = '## 更新后记录\n\n编辑后的模板正文。';
    await setValue('#wb-settings [data-template-body]', editedBody);
    await click('#wb-settings [data-template-form] [type="submit"]');
    await until(`${el('#wb-settings [data-template-status]')}.textContent.includes('已保存')`, '模板编辑保存');
    await until(`${lifeApi}.list({ kind: 'template' }).then(items => items.some(item => item.title === ${JSON.stringify(editedTitle)}))`, '模板编辑后刷新');

    const edited = await run(`${lifeApi}.list({ kind: 'template' }).then(items => items.find(item => item.title === ${JSON.stringify(editedTitle)}))`);
    assert.equal(edited.id, created.id, '编辑模板应更新原记录');
    assert.equal(edited.fields?.templateBody, editedBody);
    templateFile = path.resolve(documentsDirectory, edited.relativePath);
    markdown = await readFile(templateFile, 'utf8');
    assert.match(markdown, new RegExp(`title: .*${marker}`));
    assert.ok(markdown.includes(editedTitle), '编辑后的标题应写入 Markdown 元数据');
    assert.ok(markdown.endsWith(editedBody), '编辑后的正文应持久化到 Markdown 文件');

    await mkdir(noteDirectory, { recursive: true });
    const noteBody = `# ${noteTitle}\n\n初始笔记正文。\n`;
    await writeFile(noteFile, noteBody, { encoding: 'utf8', flag: 'wx' });
    await nav('notes');
    await until(`${el('#wb-notes [data-nw-list]')}.textContent.includes(${JSON.stringify(noteTitle)})`, '笔记自动发现');
    await run(`[...document.querySelectorAll('#wb-notes .note-workspace__archive-open')].find(button => button.textContent.includes(${JSON.stringify(noteTitle)})).click()`);
    await until(`${el('#wb-notes [data-nw-body]')}.value.includes('初始笔记正文')`, '笔记编辑器打开');
    await click('#wb-notes [data-nw-mode="source"]');
    const editor = await run(`(() => {
      const body = ${el('#wb-notes [data-nw-body]')};
      return { body: body.getBoundingClientRect().height, label: body.closest('label').getBoundingClientRect().height };
    })()`);
    assert.ok(editor.body >= 250, `笔记正文编辑区应填充可用高度：${JSON.stringify(editor)}`);
    assert.ok(Math.abs(editor.body - editor.label) <= 4, `笔记正文应填满编辑器区域：${JSON.stringify(editor)}`);

    const picker = el('#wb-notes .wb-note-template');
    await run(`${picker}.open = true`);
    const select = el('#wb-notes .wb-note-template select');
    await until(`${select}.querySelectorAll('option').length > 1`, '笔记模板选项加载');
    const inserted = await run(`(() => {
      const select = ${select};
      const option = [...select.options].find(item => item.textContent === ${JSON.stringify(editedTitle)});
      if (!option) return false;
      const body = ${el('#wb-notes [data-nw-body]')};
      body.value = '左侧保留|右侧保留';
      body.setSelectionRange(5, 5);
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(inserted, true, '笔记模板选择器应列出设置中编辑的模板');
    await until(`${el('#wb-notes [data-nw-body]')}.value.includes('编辑后的模板正文')`, '模板插入笔记正文');
    const finalBody = await run(`${el('#wb-notes [data-nw-body]')}.value`);
    assert.ok(finalBody.startsWith('左侧保留|\n\n'), '插入点左侧内容应保留');
    assert.ok(finalBody.endsWith('\n\n右侧保留'), '插入点右侧内容应保留');
    assert.ok(finalBody.includes(editedBody), '插入内容应来自编辑后的模板');
  }

  return { templateCreated: true, templateEditedAndPersisted: true, noteInsertionPreservesSurroundingText: true, notesEditorUsesFullHeight: true };
}
