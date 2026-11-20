import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runMarkdownCheck(win, { documentsDirectory, workbench, fixtureRoot }) {
  const run = source => win.webContents.executeJavaScript(source, true);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const scope = '#wb-notes';
  const body = `${scope} [data-nw-body]`;
  const preview = `${scope} [data-nw-preview]`;
  const file = path.join(documentsDirectory, 'Notes', 'Markdown_Reading_CodexV1.md');
  const source = [
    '# Markdown 阅读验收', '', '中文 **加粗内容** 与 *斜体内容*，以及 ~~删除内容~~。', '',
    '## 小节', '', '- 第一项', '  - 嵌套列表', '- [x] 已完成', '- [ ] 待完成', '',
    '> 引用内容', '', '| 字段 | 数值 |', '| --- | --- |', '| 中文表格 | 123 |', '',
    '```js', 'const value = "**保留代码里的符号**";', '```', '',
    '\\*保留转义星号\\* 和 `**行内代码**`。', '', '[跳到小节](#小节)', '',
    '<script>window.__markdownAttack = 1</script>', '',
  ].join('\n');
  async function until(expression, label) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const result = await run(expression);
      if (result) return result;
      await delay(70);
    }
    throw new Error(`Markdown 验收超时 ${label}`);
  }
  async function click(selector) {
    await until(`${q(selector)}?.getClientRects().length`, selector);
    const point = await run(`(() => {
      const element = ${q(selector)};
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  async function mode(name) {
    const button = q(`${scope} [data-nw-mode="${name}"]`);
    await until(`${button}?.getClientRects().length`, '显示模式按钮');
    await run(`${button}.click()`);
    await until(`${q(scope + ' [data-nw-content]')}.dataset.mode === ${JSON.stringify(name)}`, `切换到 ${name}`);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(140);
  }
  async function openFixture() {
    await click('[data-wb-nav="notes"]');
    const entry = `[...document.querySelectorAll('${scope} .note-workspace__archive-open')].find(element => element.textContent.includes('Markdown 阅读验收'))`;
    await until(entry, '自动发现 Markdown');
    await run(`${entry}.click()`);
    await until(`${q(body)}.value.includes('中文表格')`, '打开 Markdown');
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, { flag: 'wx' });
  await openFixture();
  await until(`${q(scope + ' [data-nw-content]')}.dataset.mode === 'reading'`, '默认阅读');
  assert.equal(await readFile(file, 'utf8'), source, '打开阅读时保留原始文件字节');
  const structure = await run(`(() => {
    const content = ${q(preview)};
    return { heading: content.querySelector('h1')?.textContent, strong: content.querySelector('strong')?.textContent,
      emphasis: !!content.querySelector('em'), deleted: !!content.querySelector('s,del'),
      nested: !!content.querySelector('li ul li'), table: !!content.querySelector('table td'),
      quote: !!content.querySelector('blockquote'), code: content.querySelector('pre code')?.textContent,
      checked: content.querySelectorAll('input[type=checkbox][checked][disabled]').length,
      unchecked: content.querySelectorAll('input[type=checkbox]:not([checked])[disabled]').length,
      escaped: content.textContent.includes('*保留转义星号*'), executable: !!content.querySelector('script,[onerror]'),
      attack: window.__markdownAttack ?? null };
  })()`);
  assert.equal(structure.heading, 'Markdown 阅读验收');
  assert.equal(structure.strong, '加粗内容');
  for (const key of ['emphasis', 'deleted', 'nested', 'table', 'quote', 'escaped']) assert.equal(structure[key], true, key);
  assert.equal(structure.checked, 1);
  assert.equal(structure.unchecked, 1);
  assert.equal(structure.executable, false);
  assert.equal(structure.attack, null);
  assert.match(structure.code, /\*\*保留代码里的符号\*\*/);
  await click(`${preview} a[href^="#"]`);
  assert.equal(await run('location.hash'), '', 'Markdown 锚点定位无需页面跳转');

  await mode('preview');
  await run(`(() => {
    const editor = ${q(body)};
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  })()`);
  await win.webContents.insertText('\n\n**实际输入后同步渲染**');
  await until(`${q(preview)}.querySelectorAll('strong').length === 2`, '实际输入的粗体预览');
  const edited = source + '\n\n**实际输入后同步渲染**';
  assert.equal(await run(`${q(body)}.value`), edited);
  await mode('source');
  assert.equal(await run(`${q(body)}.value`), edited, '切换源码保留草稿');
  await mode('reading');
  assert.equal(await run(`${q(body)}.value`), edited, '切换阅读保留草稿');
  await click(`${scope} [data-nw-save]`);
  await until(`${q(scope + ' [data-nw-metadata]')}.open`, '打开保存');
  await click(`${scope} [data-nw-cancel]`);
  assert.equal(await run(`${q(body)}.value`), edited, '取消保存保留草稿');
  await click(`${scope} [data-nw-save]`);
  await click(`${scope} [data-nw-metadata] [type=submit]`);
  await until(`!${q(scope + ' [data-nw-metadata]')}.open`, '保存完成');
  assert.equal((await workbench.listNotes({ kind: 'note' })).find(item => item.name === path.basename(file)).body, edited);

  const geometry = [];
  for (const [width, height, theme] of [[1320, 890, 'light'], [720, 620, 'dark']]) {
    win.setSize(width, height);
    await until(`Math.abs(innerWidth-${width})<=1 && Math.abs(innerHeight-${height})<=1`, '窗口调整');
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const name of ['reading', 'preview', 'source']) {
      await mode(name);
      const dimensions = await run(`(() => {
        const pane = ${q(preview)};
        const editor = ${q(body)};
        const host = ${q(scope)}.getBoundingClientRect();
        const visible = [pane, editor].filter(element => element.getClientRects().length);
        return { mode: ${JSON.stringify(name)}, width: innerWidth, theme: document.documentElement.dataset.theme,
          within: visible.every(element => { const r=element.getBoundingClientRect(); return r.width>100 && r.height>100 && r.bottom<=host.bottom+1 && r.right<=host.right+1; }),
          outerOverflow: document.getElementById('wb-main').scrollWidth > document.getElementById('wb-main').clientWidth+1 };
      })()`);
      assert.equal(dimensions.within, true, JSON.stringify(dimensions));
      assert.equal(dimensions.outerOverflow, false, JSON.stringify(dimensions));
      geometry.push(dimensions);
      if (name === 'preview') await writeFile(path.join(fixtureRoot, `markdown-preview-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await mode('reading');
    await writeFile(path.join(fixtureRoot, `markdown-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1320, 890);
  await run("document.documentElement.dataset.theme='light'");
  await win.webContents.reload();
  await until("Boolean(document.querySelector('[data-wb-nav=notes]'))", '重新加载');
  await openFixture();
  await until(`${q(preview)}.textContent.includes('实际输入后同步渲染')`, '保存后重新阅读');
  assert.equal(await run(`${q(body)}.value`), edited);
  const result = { structure, geometry, realInput: true, modeSwitchPreservesDraft: true, cancelPreservesDraft: true,
    originalBytesPreservedUntilSave: true, savedAndReopened: true };
  await writeFile(path.join(fixtureRoot, 'Markdown_Check_CodexV23.json'), JSON.stringify(result, null, 2));
  return result;
}
