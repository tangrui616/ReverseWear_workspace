import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

async function checkHomeTranslationFailures(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { mountHomeTranslation } = await import(location.origin + '/home-translation.mjs');
    const container = document.createElement('section');
    container.hidden = true;
    document.body.append(container);
    let modelsReady = false;
    let modelReads = 0;
    let finishTranslation;
    const calls = [];
    mountHomeTranslation({ container, errorText: error => error.message, api: {
      availableModels: async () => {
        modelReads++;
        return { models: modelsReady ? [
          { id: 'opus', directions: ['en-zh'] },
          { id: 'argos', directions: ['en-zh', 'zh-en'] },
        ] : [] };
      },
      lookup: async ({ text }) => {
        if (text === 'voice') return { entries: [{ translations: ['声音'] }], vocabulary: { id: 'voice' } };
        throw new Error('词典文件缺失');
      },
      translate: input => new Promise(resolve => {
        calls.push(input);
        finishTranslation = resolve;
      }),
    } });
    const find = key => container.querySelector('[data-home-tr-' + key + ']');
    const source = find('source');
    const output = find('output');
    const submit = find('submit');
    const status = find('status');
    const edit = text => {
      source.value = text;
      source.dispatchEvent(new Event('input'));
    };
    const idle = () => new Promise(resolve => setTimeout(resolve, 0));
    const lazy = modelReads === 0;
    edit('voice');
    submit.click();
    await idle();
    const lookup = { output: output.value, status: status.textContent };
    edit('missing');
    submit.click();
    await idle();
    const failure = { input: source.value, status: status.textContent, enabled: !submit.disabled };
    modelsReady = true;
    edit('English sentence.');
    submit.click();
    submit.click();
    await idle();
    const queued = calls.length;
    edit('新输入。');
    output.value = '用户译文';
    finishTranslation({ text: '旧请求结果' });
    await idle();
    const staleOutput = output.value;
    submit.click();
    await idle();
    finishTranslation({ text: 'New input.' });
    await idle();
    const finalOutput = output.value;
    container.remove();
    return { lazy, lookup, failure, queued, staleOutput, finalOutput, calls };
  })()`);
  assert.equal(result.lazy, true);
  assert.deepEqual(result.lookup, { output: '声音', status: '已查词并加入生词本' });
  assert.equal(result.failure.input, 'missing');
  assert.match(result.failure.status, /词典文件缺失.*没有可用的离线翻译模型/);
  assert.equal(result.failure.enabled, true);
  assert.equal(result.queued, 1, '翻译请求不可重复提交');
  assert.equal(result.staleOutput, '用户译文', '旧请求不可覆写新内容');
  assert.equal(result.finalOutput, 'New input.');
  assert.deepEqual(result.calls.map(({ direction, model }) => [direction, model]), [['en-zh', 'argos'], ['zh-en', 'argos']]);
}

export async function runV23HomeCheck(win, { fixtureRoot, documentsDirectory }) {
  const exec = script => win.webContents.executeJavaScript(script);
  const element = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const click = selector => exec(element(selector) + '.click()');
  const nav = view => click(`[data-wb-nav="${view}"]`);
  async function waitFor(expression) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (await exec(expression)) return;
      await delay(70);
    }
    throw new Error('V23 首页验收超时：' + expression);
  }

  await waitFor("document.querySelector('#wb-home-calendar').textContent.includes('星期')");
  await checkHomeTranslationFailures(win);
  assert.match(await exec(element('#wb-home-clock-time') + '.textContent'), /^\d\d:\d\d:\d\d$/);
  assert.match(await exec(element('#wb-home-lunar') + '.textContent'), /^农历.+月/);
  await click('#wb-home-prompt-new');
  await exec(`(() => {
    const form = document.querySelector('#wb-home dialog[open] form');
    form.elements.title.value = 'V23 提示词验收';
    form.elements.body.value = '# 标题\\n\\n两行正文。';
    form.requestSubmit();
  })()`);
  await waitFor(element('#wb-home-prompts') + '.textContent.includes("V23 提示词验收")');
  const promptFolder = path.join(documentsDirectory, 'Prompts');
  const promptFiles = await readdir(promptFolder);
  assert.equal(promptFiles.length, 1);
  assert.match(await readFile(path.join(promptFolder, promptFiles[0]), 'utf8'), /# 标题\n\n两行正文。$/);
  await exec(`(() => {
    const form = document.getElementById('wb-home-todo-form');
    form.elements.text.value = 'V23 首页待办';
    form.requestSubmit();
  })()`);
  await waitFor(element('#wb-home-todos') + '.textContent.includes("V23 首页待办")');
  await click('#wb-home-todos input');
  await waitFor(`window.stilltimeDesktop.workbench.getPlan({period:'day'}).then(result => result.tasks.some(task => task.text === 'V23 首页待办' && task.done))`);
  await click('[data-today-plan]');
  await waitFor(element('#wb-plans') + '.textContent.includes("V23 首页待办")');
  await nav('home');
  await waitFor(element('#wb-home-todos input') + '?.checked');
  await click('#wb-stopwatch-start');
  await waitFor('!document.getElementById("wb-stopwatch-stop").hidden');
  await click('#wb-stopwatch-stop');
  await waitFor('document.getElementById("wb-stopwatch-dialog").open');
  await exec(`(() => {
    document.getElementById('wb-stopwatch-task').value = 'V23 计时验收';
    document.querySelector('[data-stopwatch-form]').requestSubmit();
  })()`);
  await waitFor('!document.getElementById("wb-stopwatch-dialog").open');
  await waitForOuroboros(() => readOuroboros(win, 'window.__frames > 4'), '首页动画已渲染');
  await delay(1500);
  await writeFile(path.join(fixtureRoot, 'home-v23.png'), (await win.webContents.capturePage()).toPNG());

  const panels = ['home', 'ideas', 'weekly', 'links', 'notes', 'experiments', 'plans', 'files', 'translation', 'life', 'clipboard', 'settings'];
  const layout = [];
  for (const [width, height] of [[1320, 890], [720, 620]]) {
    win.setSize(width, height);
    for (const view of panels) {
      await nav(view);
      await waitFor('!' + element('#wb-' + view) + '.hidden');
      const edges = await exec(`(() => {
        const canvas = document.querySelector('.wb-canvas');
        const main = document.querySelector('.wb-main');
        const style = getComputedStyle(canvas);
        return {padding:[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft],
          horizontalOverflow:main.scrollWidth > main.clientWidth + 1};
      })()`);
      assert.deepEqual(edges.padding, ['16px', '16px', '16px', '16px'], view);
      assert.equal(edges.horizontalOverflow, false, view);
      layout.push({ width, view, ...edges });
    }
  }
  await writeFile(path.join(fixtureRoot, 'layout-v23.json'), JSON.stringify(layout, null, 2));
  win.setSize(1320, 890);
  await nav('home');
}
