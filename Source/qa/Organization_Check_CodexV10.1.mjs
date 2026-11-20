import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { dialog } from 'electron';

export async function runOrganizationCheck(win, { documentsDirectory, workbench, markdown }) {
  const js = code => win.webContents.executeJavaScript(code, true);
  const selector = query => 'document.querySelector(' + JSON.stringify(query) + ')';
  const click = query => js(selector(query) + '.click()');
  const input = (query, value) => js(`(() => {
    const field = ${selector(query)};
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  const until = async (query, description) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await js(query)) return;
      await wait(35);
    }
    throw new Error('工作台整理验收超时：' + description);
  };
  const screenshot = path.join(path.dirname(documentsDirectory), 'sample.png');
  await writeFile(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nv9sAAAAASUVORK5CYII=', 'base64'));
  const openDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [screenshot] });
  try {
    await until('Boolean(document.querySelector("[data-idea-tab=board]"))', '工作台加载完成');
    await click('[data-wb-nav=ideas]');
    await click('[data-idea-tab=board]');
    await input('[data-board-form] [name=title]', '晨光中的构图');
    await input('[data-board-form] [name=url]', 'https://example.org/article');
    await input('[data-board-form] [name=special]', '视觉主次清楚');
    await input('[data-board-form] [name=borrow]', '使用不同大小的留空');
    await click('[data-board-image]');
    await until('Boolean(document.querySelector("[data-board-image-preview] img")?.naturalWidth)', '截图导入并显示');
    await click('[data-board-form] [type=submit]');
    await until('document.querySelector("[data-board-cards]").textContent.includes("晨光中的构图")', '灵感板保存');
    const [board] = await js('window.stilltimeDesktop.inspiration.list()');
    const boardFile = path.join(documentsDirectory, 'InspirationBoard', board.id + '.md');
    const boardText = await readFile(boardFile, 'utf8');
    assert.match(boardText, /## 它特别在哪\n视觉主次清楚/);
    assert.match(boardText, /## 我能借鉴什么\n使用不同大小的留空/);
    await writeFile(boardFile, boardText.replace('视觉主次清楚', '外部编辑后更新'));
    await until('document.querySelector("[data-board-cards]").textContent.includes("外部编辑后更新")', '监控外部 Markdown 修改');
    assert.equal((await js('window.stilltimeDesktop.risk.search("编辑后更新")'))[0].id, board.id);
  } finally {
    dialog.showOpenDialog = openDialog;
  }
  const first = (await workbench.saveLink({ title: '主链接', url: 'http://127.0.0.1/article' })).item;
  const linkDirectory = path.join(documentsDirectory, 'Links');
  const duplicate = 'd76133ce-3e0a-4ef9-b74c-f3f14909a093';
  const original = await readFile(path.join(linkDirectory, first.id + '.md'), 'utf8');
  await writeFile(path.join(linkDirectory, duplicate + '.md'), original
    .replace(first.id, duplicate).replace('主链接', '第二条记录').replace('/article"', '/article#anchor"'));
  await click('[data-wb-nav=links]');
  await click('[data-wc-refresh]');
  await until('document.querySelectorAll(".web-collection__entry").length === 2', '收藏目录条目');
  // Organization contracts remain available for stored files from older versions.
  // The V23 collection exposes individual metadata and tag filters in its current UI.
  const ids = [first.id, duplicate];
  const bulk = await js(`window.stilltimeDesktop.links.bulkTag(${JSON.stringify({ ids, add: ['研究/病理语音'] })})`);
  assert.equal(bulk.changed, 2, '历史批量整理 IPC 继续支持已有链接');
  await js(`window.stilltimeDesktop.links.saveTagAliases(${JSON.stringify({ tag: '研究/病理语音', aliases: ['语音研究'] })})`);
  const organized = await js('window.stilltimeDesktop.links.listLinks()');
  assert.ok(organized.tags.some(tag => tag.name === '研究/病理语音' && tag.aliases.includes('语音研究')));
  const group = organized.duplicateGroups[0];
  assert.ok(group && group.items.length === 2, '已有重复网址可识别');
  await js(`window.stilltimeDesktop.links.setPrimary(${JSON.stringify({ canonicalUrl: group.canonicalUrl, primaryId: duplicate })})`);
  await until(`window.stilltimeDesktop.links.listLinks().then(value => value.duplicateGroups[0]?.primaryId === "${duplicate}")`, '选择主要记录');
  assert.equal((await js('window.stilltimeDesktop.links.undo()')).undone, true, '主要记录选择可以撤销');
  await until(`window.stilltimeDesktop.links.listLinks().then(value => !value.canUndo)`, '撤销主记录选择');
  const checked = await js(`window.stilltimeDesktop.links.check(${JSON.stringify({ ids })})`);
  assert.equal(checked.length, 2);
  assert.ok(checked.every(item => item.status === 'unknown'), '本机地址检查保留明确的未知结果');
  await click('[data-wc-refresh]');
  await until('document.querySelector(".web-collection__list").textContent.includes("研究/病理语音")', '整理结果显示在当前收藏目录');
  await js("[...document.querySelectorAll('.web-collection__section')].find(button => button.textContent === '研究/病理语音').click()");
  await until('document.querySelectorAll(".web-collection__entry").length === 2', '当前收藏标签筛选');
  await input('[data-wc-search]', '第二条记录');
  await until('document.querySelectorAll(".web-collection__entry").length === 1', '当前收藏标题搜索');
  await input('[data-wc-search]', '');
  assert.equal((await workbench.listLinks()).length, 2);

  const ideasDirectory = path.join(documentsDirectory, 'Ideas');
  await mkdir(ideasDirectory, { recursive: true });
  for (let start = 0; start < 1000; start += 50) {
    await Promise.all(Array.from({ length: 50 }, (_value, index) => {
      const n = start + index;
      const id = 'f76133ce-3e0a-4ef9-b74c-' + String(n).padStart(12, '0');
      const title = '病理Voice 样本 ' + n;
      return writeFile(path.join(ideasDirectory, id + '.md'), `---\nid: "${id}"\ntype: "idea"\nschema: 1\ntitle: "${title}"\noriginal: "用于筛选的内容"\n---\n# ${title}\n`);
    }));
  }
  markdown.invalidate();
  await markdown.read();
  await click('[data-wb-nav=ideas]');
  await click('[data-idea-tab=cards]');
  await until('document.querySelector("[data-idea-count]").textContent === "1000 张"', '1000 张卡片初次显示');
  const duration = await js(`(async () => {
    const started = performance.now();
    const field = document.querySelector('[data-idea-search]');
    field.value = '病理voice 999';
    field.dispatchEvent(new Event('input', {bubbles: true}));
    while (document.querySelector('[data-idea-count]').textContent !== '1 张') {
      if (performance.now() - started > 2500) throw new Error('灵感筛选超时');
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    return performance.now() - started;
  })()`);
  assert.ok(duration < 200, `1000 卡片温态筛选耗时 ${duration} ms`);
  console.log('ORGANIZATION_VERIFY_OK', JSON.stringify({ cards: 1000, filterMs: duration.toFixed(1) }));
  win.close();
}
