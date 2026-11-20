import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

export async function runResearchCheck(win, workbench, research) {
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root, 'Use an isolated data root');
  const evaluate = expression => win.webContents.executeJavaScript(expression, true);
  const element = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => evaluate(element(selector) + '.click()');
  const nav = view => click('.wb-nav [data-wb-nav=' + view + ']');
  const report = {};
  async function until(expression) {
    const deadline = Date.now() + 12000;
    do {
      const result = await evaluate(expression);
      if (result) return result;
      await delay(100);
    } while (Date.now() < deadline);
    const pageText = await evaluate('document.querySelector("#wb-main").innerText');
    throw new Error('Timed out: ' + expression + '\n' + pageText);
  }
  const has = (selector, content) => until(element(selector) + '?.textContent?.includes(' + JSON.stringify(content) + ')');
  const field = (selector, value) => evaluate(`(() => {
    const input = ${element(selector)};
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const capture = async name => writeFile(path.join(root, name), (await win.capturePage()).toPNG());
  await until('document.querySelector("#wb-space iframe")');
  await waitForOuroboros(() => readOuroboros(win, 'window.__frames > 3'), 'Three.js animation frames');
  await delay(300);
  await capture('Stilltime_Ouroboros_CodexV8.png');
  report.threeRendered = true;

  const { item: link } = await workbench.saveLink({ url: 'https://example.invalid/article', title: 'Markdown 回写验收' });
  const handoff = await workbench.linkWorkspace(link.id);
  const original = await readFile(handoff.linkFile, 'utf8');
  await nav('links');
  await has('.web-collection__entry', 'Markdown 回写验收');
  await click('.web-collection__entry');
  await until(`${element('[data-wc-title]')}.value === ${JSON.stringify(link.title)}`);
  const note = '外部分析_CodexV1.md';
  await writeFile(path.join(handoff.folder, note), '# 外部工具写回\n\n可核验的测试正文。', 'utf8');
  await click('[data-wc-notes] [data-nw-list-toggle]');
  await click('[data-wc-notes] [data-nw-refresh]');
  await has('[data-wc-notes] [data-nw-list]', '外部工具写回');
  await click('[data-wc-notes] .note-workspace__archive-open');
  await until(`${element('[data-wc-notes] [data-nw-body]')}.value.includes('可核验的测试正文。')`);
  assert.equal(await readFile(handoff.linkFile, 'utf8'), original);
  await assert.rejects(workbench.readLinkNote(link.id, '../outside.md'));
  await capture('Stilltime_Link_Notes_CodexV8.png');
  report.linkMarkdownRoundTrip = true;

  await verifyResearchUi({ nav, click, field, until, has, evaluate, capture, research, root });
  report.experimentMarkdownAndDailyTask = true;
  report.weeklyGoal = true;
  await writeFile(path.join(root, 'Research_Verification_CodexV8.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('RESEARCH_VERIFY_OK', JSON.stringify(report));
  win.close();
}

async function verifyResearchUi({ nav, click, field, until, has, evaluate, capture, research, root }) {
  await nav('experiments');
  const name = '语音声学参数复测';
  const today = await evaluate('document.querySelector("#wb-today").dateTime');
  const input = { name, date: today, progress: 35, next: '重跑三个样本' };
  for (const [key, value] of Object.entries(input)) await field('[data-research-create] [name=' + key + ']', value);
  await click('[data-research-create-submit]');
  await has('[data-research-card]', name);
  await capture('Stilltime_Experiments_CodexV8.png');
  await click('[data-research-card]');
  const design = '# 样本\n\n## 采样方案\n双盲复测';
  await field('[data-research-editor] [name=design]', design);
  await click('[data-research-tab=rounds]');
  await field('[data-research-editor] [name=rounds]', '第 1 轮复测。');
  await click('[data-research-save]');
  await until('document.querySelector("#wb-notice").textContent.includes("记录已保存")');
  await capture('Stilltime_Experiment_Editor_CodexV8.png');
  await click('[data-research-add-todo]');
  await until('document.querySelector("#wb-notice").textContent.includes("已加入今日待办")');
  await click('[data-research-complete]');
  await has('[data-research-card]', '已完成');
  const [updated] = await research.listExperiments();
  assert.equal(updated.progress, 100);
  assert.equal(updated.design, design);
  assert.equal(updated.rounds, '第 1 轮复测。');
  assert.equal((await readdir(path.join(root, 'Documents', 'Experiments'))).filter(file => file.endsWith('.md')).length, 1);
  const plan = await research.getPlan({ period: 'day', date: today });
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].text, input.next);
  assert.equal(plan.tasks[0].experimentId, updated.id);
  await nav('plans');
  await evaluate(`[...document.querySelectorAll('.wb-plan-tabs button')].find(button => button.textContent === '计划与目标').click()`);
  await has('#wb-plans', input.next);
  await click('[data-research-task-list=day] input[type=checkbox]');
  await has('[data-plan-summary=day]', '1 / 1');
  assert.equal((await research.getPlan({ period: 'day', date: today })).tasks[0].done, true);
  await field('[data-research-task-form=week] [name=text]', '写完实验小结');
  await click('[data-research-task-form=week] [type=submit]');
  await has('[data-research-task-list=week]', '写完实验小结');
  await evaluate(`[...document.querySelectorAll('.wb-plan-tabs button')].find(button => button.textContent === '备忘录').click()`);
  await field('.wb-memos [data-nw-body]', '检查设备零点\n复测前记录仪器状态。');
  await click('.wb-memos [data-nw-save]');
  await click('.wb-memos [data-nw-metadata] [type=submit]');
  await until('!document.querySelector(".wb-memos [data-nw-metadata]").open');
  assert.equal((await readdir(path.join(root, 'Documents', 'Memos'))).filter(file => file.endsWith('.md')).length, 1);
  await capture('Stilltime_Plans_CodexV8.png');
}
