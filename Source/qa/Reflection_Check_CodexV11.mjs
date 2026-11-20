import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { clipboard } from 'electron';
import { samplePdf } from './Workbench_Check_CodexV7.mjs';

export async function runReflectionCheck(win, { documentsDirectory, workbench, ideas, weeklyReview, markdown }) {
  const run = expression => win.webContents.executeJavaScript(expression, true);
  const field = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => run(field(selector) + '.click()');
  const value = (selector, text, event = 'input') => run(`(() => {
    const input = ${field(selector)};
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
  const until = async (expression, label) => {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      if (await run(expression)) return;
      await wait(40);
    }
    throw new Error('V11 界面验收超时：' + label);
  };
  const note = await workbench.saveNote({ kind: 'daily', title: '声学日志', body: '背景文本\n\n声学 Voice onset 校验段落。', tags: ['方法'] });
  await workbench.saveNote({ kind: 'weekly', title: '反向引用样例', body: '见 [[' + note.id + ']]。' });
  const pdfPath = path.join(path.dirname(documentsDirectory), 'V11Fixture.pdf');
  await writeFile(pdfPath, samplePdf());
  const { items: [pdf] } = await workbench.importFiles([pdfPath]);
  await workbench.saveNote({ kind: 'note', title: '第 2 页', body: 'PDFV11 定位正文', fileId: pdf.id, page: 2 });
  const seed = (await ideas.createIdea({ title: '拖到培养中', original: '新的想法' })).item;
  const archived = (await ideas.createIdea({ title: '待拍板', original: '可恢复的想法' })).item;
  const fridge = (await ideas.createIdea({ title: '冰箱中的旧想法', original: '重新看看' })).item;
  await ideas.saveIdea({ id: fridge.id, status: 'fridge', expectedUpdatedAt: fridge.updatedAt });
  markdown.invalidate();
  await markdown.read();
  await until("Boolean(document.querySelector('.wb-global-search'))", '主窗口挂载成功');

  const searchInput = '.wb-global-search [data-query]';
  const result = '.wb-global-result.is-active';
  const openSearch = async query => {
    await click('[data-global-search-open]');
    await value(searchInput, query);
    await until(`Boolean(${field(result)})`, '搜索 ' + query);
  };
  await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))");
  await until(`Boolean(${field('.wb-global-search[open]')})`, 'Ctrl+K');
  await value(searchInput, '声学 voice');
  await value('.wb-global-search [data-filter=type]', 'daily', 'change');
  await value('.wb-global-search [data-filter=tag]', '方法');
  await until(`${field(result)}?.textContent.includes('声学日志') && Boolean(${field('.wb-global-result mark')})`, '中英混合过滤和高亮');
  await until(`${field('[data-backlink-list] button')}?.textContent.includes('反向引用样例')`, '反向链接');
  const previousClipboard = await clipboard.readText();
  try {
    await click('[data-copy-reference]');
    await until(`${field('[data-copy-reference]')}.textContent === '引用已复制'`, '复制稳定引用');
    assert.equal(await clipboard.readText(), '[[' + note.id + ']]');
  } finally { await clipboard.writeText(previousClipboard); }
  await click(result);
  const dailyEditor = '#wb-notes [data-nw-body]';
  await until(`!${field('#wb-notes')}.hidden && ${field(dailyEditor)}.selectionStart > 0`, '打开日报并选中文字');
  assert.equal(await run(`${field(dailyEditor)}.value.slice(${field(dailyEditor)}.selectionStart,${field(dailyEditor)}.selectionEnd)`), '声学 Voice onset 校验段落。');

  await click('[data-global-search-open]');
  await value('.wb-global-search [data-filter=type]', '', 'change');
  await value('.wb-global-search [data-filter=tag]', '');
  await openSearch('PDFV11');
  await click(result);
  await until(`${field('.workbench-pdf__page-input')}?.value === '2' && ${field('[data-pdf-notes] [data-nw-title]')}?.textContent === '第 2 页'`, '结果打开 PDF 原页与关联笔记');

  await click('[data-wb-nav=ideas]');
  await click('[data-idea-tab=kanban]');
  const card = '[data-idea-card="' + seed.id + '"]';
  await until(`Boolean(${field('[data-kanban-status=seed] ' + card)})`, '种子卡片');
  await run(`(() => {
    const dataTransfer = new DataTransfer();
    ${field(card)}.dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer }));
    ${field('[data-kanban-status=growing]')}.dispatchEvent(new DragEvent('drop', { bubbles:true, dataTransfer }));
  })()`);
  await until(`Boolean(${field('[data-kanban-status=growing] ' + card)})`, '拖入培养中并刷新');
  assert.equal((await ideas.getIdea(seed.id)).status, 'growing');

  await click('[data-wb-nav=weekly]');
  await until(`${field('[data-week-label]')}.textContent.includes(' 至 ')`, '加载本周');
  const week = await weeklyReview.currentWeek();
  const draft = await weeklyReview.writeDraftTemplate({ week });
  await writeFile(draft.path, '# 本地 Harness 返回\n可审核的意见');
  await click('[data-draft-refresh]');
  await until(`${field('[data-draft-content]')}.textContent.includes('可审核的意见')`, '读取隔离 Harness 草稿');
  await click('[data-draft-review]');
  await until(`Boolean(${field('.wb-risk-dialog[open]')})`, '打开已有 AI 审核');
  await click('.wb-risk-dialog header button');
  await value('[data-recap-win]', '周复盘的验收收获');
  await value('[data-recap-stuck]', '尚需改善一种方法');
  await value('[data-recap-next]', '下周做一项基线');
  await value('[data-week-ideas] select[aria-label$="待拍板"]', 'archived', 'change');
  await click('[data-week-save-decisions]');
  await until(`${field('[data-week-decision-status]')}.textContent.includes('已保存 1 条')`, '本周想法决定');
  assert.equal(await run(`${field('[data-recap-win]')}.value`), '周复盘的验收收获');
  await click('[data-week-save-recap]');
  await until(`${field('[data-week-recap-status]')}.textContent.includes('已保存')`, '复盘写入 Markdown');
  const reviewFile = path.join(documentsDirectory, 'WeeklyReviews', week + '.md');
  const body = await readFile(reviewFile, 'utf8');
  assert.match(body, /private: true/);
  assert.match(body, /周复盘的验收收获/);
  assert.equal((await ideas.getIdea(archived.id)).weeklyDecisions[week], 'archived');
  await click('[data-week-previous]');
  await until(`${field('[data-week-label]')}.textContent.includes(' 至 ') && !${field('[data-week-label]')}.textContent.startsWith(${JSON.stringify(week)})`, '浏览上一周');
  await openSearch('验收收获');
  await click(result);
  await until(`!${field('#wb-weekly')}.hidden && ${field('[data-recap-win]')}.value === '周复盘的验收收获'`, '从索引回到指定周次');
  await click('[data-wb-nav=home]');
  await until(`${field('#wb-resurfacing-title')}.textContent === '冰箱中的旧想法'`, '首页重现旧想法');
  await click('#wb-resurfacing-open');
  await until(`${field('#wb-ideas [data-idea-edit] [name=title]')}?.value === '冰箱中的旧想法'`, '打开重现卡片');
  console.log('REFLECTION_VERIFY_OK', JSON.stringify({ notes: true, pdfPage: 2, backlinks: true, kanban: true, weekly: week, privateRecap: true, resurfaced: true }));
}
