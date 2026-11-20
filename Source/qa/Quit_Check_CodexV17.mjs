import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runQuitCheck(win, { workbench } = {}) {
  assert.ok(win && !win.isDestroyed(), '退出验收需要正在运行的主窗口。');
  assert.ok(workbench?.listNotes, '退出验收需要主进程笔记读取接口。');
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root, '退出验收必须使用隔离数据目录。');
  await mkdir(root, { recursive: true });

  const inspect = expression => win.webContents.executeJavaScript(expression, true);
  const element = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const click = selector => inspect(`${element(selector)}?.click()`);
  const set = (selector, value) => inspect(`(() => {
    const field = ${element(selector)};
    if (!field) return false;
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  async function until(predicate, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(60);
    }
    throw new Error(`V17 退出验收等待超时：${label}`);
  }
  const nav = view => click(`.wb-nav [data-wb-nav="${view}"]`);
  const notes = '#wb-notes';
  const body = `${notes} [data-nw-body]`;
  const metadata = `${notes} [data-nw-metadata]`;
  const firstText = 'QUIT草稿甲';
  const secondText = 'QUIT草稿乙';
  const thirdText = 'QUIT草稿丙';

  await until(() => inspect(`${element('#wb-quit')} && ${element('[data-window-command="close"]')} && ${element('[data-window-command="maximize"]')}`), '主窗口和自定义标题栏');
  await click('[data-window-command="maximize"]');
  await until(() => win.isMaximized(), '最大化按钮');
  await click('[data-window-command="maximize"]');
  await until(() => !win.isMaximized(), '最大化按钮恢复窗口');
  await click('[data-window-command="minimize"]');
  await until(() => win.isMinimized(), '最小化按钮');
  win.restore();
  await until(() => !win.isMinimized(), '恢复最小化窗口');

  await nav('notes');
  await until(() => inspect(`${element(notes)} && !${element(notes)}.hidden && ${element(`${notes} [data-nw-new]`)}`), '笔记工作区');
  await click(`${notes} [data-nw-new]`);
  await set(body, `# ${firstText}\n\n这份草稿用于检查退出时能否定位和重新保存。`);
  await click(`${notes} [data-nw-new]`);
  await set(body, `# ${secondText}\n\n第二份草稿应在切换标签时继续保留。`);
  await click(`${notes} [data-nw-new]`);
  await set(body, `# ${thirdText}\n\n第三份草稿用于检查退出提示恢复。`);
  await until(() => inspect(`${element(body)}?.value.includes(${JSON.stringify(thirdText)})`), '第三份草稿输入');

  const beforeUnload = await inspect(`(() => {
    const event = new Event('beforeunload', { cancelable: true });
    const allowed = window.dispatchEvent(event);
    return { allowed, prevented: event.defaultPrevented };
  })()`);
  assert.equal(beforeUnload.prevented, true, '带有草稿时 beforeunload 应被拦截。');

  await click('[data-window-command="close"]');
  await until(() => inspect(`${element('#wb-quit')}.open`), '真实窗口关闭请求显示退出对话框');
  const dialogText = await inspect(`${element('#wb-quit')}.textContent`);
  assert.match(dialogText, /未保存|修改/, '退出对话框应说明存在未保存内容。');
  await inspect(`(() => {
    const dialog = ${element('#wb-quit')};
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  })()`);
  await until(() => inspect(`!${element('#wb-quit')}.open`), 'Escape 关闭退出对话框');
  win.close();
  await until(() => inspect(`${element('#wb-quit')}.open`), '取消退出提示后再次关闭仍显示提示');
  await inspect(`${element('#wb-quit')}.close()`);
  await until(() => inspect(`!${element('#wb-quit')}.open`), '直接关闭退出浮层');
  win.close();
  await until(() => inspect(`${element('#wb-quit')}.open`), '直接关闭浮层后再次提示');
  await click('[data-quit-view]');
  await until(() => inspect(`document.querySelectorAll('#wb-quit [data-quit-target]').length >= 3`), '退出对话框列出三份草稿');

  await inspect(`(() => {
    const target = [...document.querySelectorAll('#wb-quit [data-quit-target]')]
      .find(item => item.textContent.includes(${JSON.stringify(firstText)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await until(() => inspect(`${element(body)}?.value.includes(${JSON.stringify(firstText)})`), '跳转到第一份草稿');
  await inspect(`(() => {
    const tab = [...document.querySelectorAll('#wb-notes [data-nw-tabs] [role=tab]')]
      .find(item => item.textContent.includes(${JSON.stringify(secondText)}));
    tab?.click();
  })()`);
  await until(() => inspect(`${element(body)}?.value.includes(${JSON.stringify(secondText)})`), '切换后第二份草稿仍保留');
  await inspect(`(() => {
    const tab = [...document.querySelectorAll('#wb-notes [data-nw-tabs] [role=tab]')]
      .find(item => item.textContent.includes(${JSON.stringify(firstText)}));
    tab?.click();
  })()`);
  await until(() => inspect(`${element(body)}?.value.includes(${JSON.stringify(firstText)})`), '切回第一份草稿');
  await inspect(`(() => {
    const dialog = ${element('#wb-quit')};
    if (dialog?.open) dialog.close('return-to-editor');
    const editor = ${element(body)};
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  })()`);
  await until(() => inspect(`${element(metadata)}?.open`), 'Ctrl+S 打开笔记保存窗口');
  await set(`${metadata} [name=tags]`, 'V17退出验收');
  await click(`${metadata} [type=submit]`);
  await until(() => inspect(`!${element(metadata)}?.open`), '第一份草稿重新保存');
  const stored = await inspect(`window.stilltimeDesktop.workbench.listNotes({ kind: 'note' })`);
  assert.ok(stored.some(item => item.body.includes(firstText)), '定位后的草稿应已写入归档。');
  assert.equal(await inspect(`${element(body)}?.value.includes(${JSON.stringify(firstText)})`), true,
    '工作区应保持第一份草稿供保存。');

  await nav('home');
  await click('#wb-stopwatch-start');
  win.close();
  await until(() => inspect(`${element('#wb-quit')}.open`), '第二次关闭显示计时和笔记');
  await click('[data-quit-save]');
  await until(() => inspect(`${element('#wb-stopwatch-dialog')}.open`), '保存并关闭时补填活动');
  await set('#wb-stopwatch-task', '退出计时验收');
  await click('[data-stopwatch-cancel]');
  await until(() => inspect(`!${element('#wb-stopwatch-dialog')}.open`), '取消计时保存后返回工作台');
  assert.equal(await inspect(`${element('#wb-stopwatch-task')}.value`), '退出计时验收');
  await delay(250);

  win.close();
  await until(() => inspect(`${element('#wb-quit')}.open`), '再次关闭保留两份内容');
  await click('[data-quit-save]');
  await until(() => inspect(`${element('#wb-stopwatch-dialog')}.open`), '重试保存显示计时活动');
  assert.equal(await inspect(`${element('#wb-stopwatch-task')}.value`), '退出计时验收');
  await click('[data-stopwatch-form] [type=submit]');
  await until(() => win.isDestroyed(), '保存完成后关闭主窗口');
  const finalStored = await workbench.listNotes({ kind: 'note' });
  assert.ok(finalStored.some(item => item.body.includes(secondText)), '保存并关闭应保存第二份草稿。');
  assert.ok(finalStored.some(item => item.body.includes(thirdText)), '保存并关闭应保存第三份草稿。');

  const evidence = {
    nativeControls: { minimize: true, maximize: true, restore: true },
    beforeUnloadBlocked: true,
    draftLocation: { multipleNotes: true, firstDraftFocusedAndResaved: true, secondDraftPreserved: true, thirdDraftPreserved: true },
    quitPromptDismissal: { threeUnsavedNotes: true, secondCloseShowsPrompt: true },
    saveAndClose: true,
    timerDraftRetainedOnCancel: true,
  };
  await writeFile(path.join(root, 'Quit_Check_CodexV17.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('QUIT_V17_VERIFY_OK', JSON.stringify(evidence));
}
