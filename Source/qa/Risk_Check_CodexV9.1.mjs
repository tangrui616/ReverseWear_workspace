import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export async function runRiskCheck(win) {
  const root = process.env.STILLTIME_DEV_DATA_ROOT;
  assert.ok(root);
  const inspect = js => win.webContents.executeJavaScript(js, true);
  async function until(js) {
    for (let n = 0; n < 120; n++) {
      const value = await inspect(js);
      if (value) return value;
      await pause(100);
    }
    const state = await inspect(`(async () => ({ title: document.title, hidden: document.hidden, workbench: document.getElementById('workbench')?.hidden,
      home: document.getElementById('wb-home')?.hidden, frame: document.querySelector('#wb-space iframe')?.src,
      selected: document.querySelector('[data-wb-nav=home]')?.getAttribute('aria-current'),
      active: await window.stilltimeDesktop.risk.getRenderActivity(),
      preferences: await window.stilltimeDesktop.risk.preferences() }))()`);
    throw new Error('Risk verify did not reach: ' + js + ' ' + JSON.stringify(state));
  }
  const opener = name => inspect(`document.querySelector('[data-risk-open="${name}"]').click()`);
  await until('!!document.querySelector("#wb-space iframe")');
  await until('!!document.querySelector("[data-risk-open=mirror]")');
  assert.equal(await inspect('document.title.includes("反穿衣工作台")'), true);
  const ordinary = await inspect("fetch('/api/library').then(result => result.json())");
  assert.ok(ordinary.items.some(item => item.kind === 'image'));
  assert.ok(ordinary.items.some(item => item.kind === 'video'));
  assert.ok(ordinary.warnings.some(message => message.includes('不存在')));
  assert.ok(ordinary.items.every(item => !item.title.includes('镜流')));
  win.minimize();
  await until('!document.querySelector("#wb-space iframe")');
  win.restore();
  win.focus();
  await until('!!document.querySelector("#wb-space iframe")');
  const setDisplay = options => inspect(`window.stilltimeDesktop.risk.savePreferences(${JSON.stringify(options)}).then(value => {
    dispatchEvent(new CustomEvent('stilltime-risk-preferences', { detail: value })); return value;
  })`);
  const display = await setDisplay({ showOuroboros: false, dayStartMinutes: 240 });
  assert.equal(display.dayStartMinutes, 240);
  await until('!document.querySelector("#wb-space iframe")');
  await setDisplay({ showOuroboros: true });
  await until('!!document.querySelector("#wb-space iframe")');

  const inserted = await inspect("window.stilltimeDesktop.workbench.saveLink({url:'https://example.invalid/paper',title:'语音分类',tags:['数据集']})");
  const linkId = inserted.item.id;
  const item = JSON.stringify(linkId);
  await inspect(`window.stilltimeDesktop.risk.saveLinkSnapshot(${item}, '测试正文<script>window.__danger = 1</script>')`);
  const snapshots = await inspect(`window.stilltimeDesktop.risk.listLinkSnapshots(${item})`);
  assert.equal(snapshots.length, 1);
  const result = await inspect('window.stilltimeDesktop.risk.search("语音分类")');
  assert.equal(result[0].title, '语音分类');
  await inspect("document.querySelector('[data-global-search-open]').click()");
  await until("!!document.querySelector('.wb-global-search[open] input[type=search]')");
  await inspect("document.querySelector('.wb-global-search').close()");
  const migrated = await inspect('window.stilltimeDesktop.risk.migrate()');
  assert.equal(migrated.issues.length, 0);
  const mirror = path.join(root, 'AI-Mirror');
  const noteDir = path.join(mirror, 'LinkNotes', linkId);
  await mkdir(noteDir, { recursive: true });
  const noteId = '2e13d3e4-1a63-42c5-a51a-900099001111';
  const markdown = `---\nid: ${noteId}\nschema: 1\ntype: link-note\ntitle: 测试草稿\nrelatedId: ${linkId}\n---\n<script>window.__danger = 2</script>\n<img onerror=alert(1)>\n[测试](javascript:alert(1))\n`;
  await writeFile(path.join(noteDir, noteId + '.md'), markdown, { flag: 'wx' });
  await inspect('document.querySelector("[data-wb-nav=settings]").click()');
  await opener('mirror');
  await until("document.querySelector('.wb-risk-dialog')?.textContent.includes('测试草稿')");
  await inspect(`[...document.querySelectorAll('.wb-risk-dialog button')].find(button => button.textContent === '接受' && !button.disabled).click()`);
  await until("document.querySelector('.wb-risk-dialog')?.textContent.includes('审核已接受')");
  const written = await readFile(path.join(root, 'Documents', 'LinkNotes', linkId, noteId + '.md'), 'utf8');
  assert.ok(written.includes('window.__danger = 2'));
  assert.equal(await inspect('typeof window.__danger'), 'undefined');
  assert.equal(await inspect("document.querySelector('.wb-risk-dialog [onerror], .wb-risk-dialog script') == null"), true);
  console.log('RISK_VERIFY_OK');
  win.close();
}
