import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function runPublicCoreCheck(win, { fixtureRoot, documentsDirectory }) {
  const run = expression => win.webContents.executeJavaScript(expression);
  const selector = value => `document.querySelector(${JSON.stringify(value)})`;
  const click = value => run(`${selector(value)}?.click()`);
  const nav = view => click(`[data-wb-nav="${view}"]`);
  async function until(expression) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await run(expression)) return;
      await delay(80);
    }
    throw new Error(`Public core check timed out: ${expression}`);
  }

  await until(`${selector('#st-skip')}?.getClientRects().length > 0`);
  await click('#st-skip');
  await until(`!${selector('#st-splash')} && Boolean(${selector('#wb-home-clock-time')}?.textContent)`);
  assert.match(await run(`${selector('#wb-home-clock-time')}.textContent`), /^\d{2}:\d{2}:\d{2}$/);

  const status = await run('window.stilltimeDesktop.translation.availableModels()');
  const translationUnavailable = Array.isArray(status.models) && status.models.every(model => !model.available)
    && (status.models.length > 0 || /找不到|不可用/i.test(status.error ?? ''));
  assert.equal(translationUnavailable, true, 'missing offline translation assets report unavailable');
  const dictionaryUnavailable = await run(`window.stilltimeDesktop.translation.lookup({ text: 'trial' })
    .then(() => false, error => /未找到词典/.test(error.message))`);
  assert.equal(dictionaryUnavailable, true, 'missing offline dictionary reports unavailable');
  await until(`${selector('[data-wb-nav="notes"]')}.getClientRects().length > 0`);
  await nav('notes');
  await until(`!${selector('#wb-notes')}.hidden`);

  await click('#wb-notes [data-nw-new]');
  await until(`Boolean(${selector('#wb-notes [data-nw-body]')})`);
  const body = 'Public trial note round trip.';
  await run(`(() => { const field = ${selector('#wb-notes [data-nw-body]')}; field.value = ${JSON.stringify(body)}; field.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('#wb-notes [data-nw-save]');
  await until(`${selector('#wb-notes [data-nw-metadata]')}.open`);
  await click('#wb-notes [data-nw-metadata] [type=submit]');
  await until(`!${selector('#wb-notes [data-nw-metadata]')}.open`);

  const files = await readdir(path.join(documentsDirectory, 'Notes'));
  const noteFile = files.find(file => file.endsWith('.md'));
  assert.ok(noteFile, 'note saved through the normal UI bridge');
  assert.match(await readFile(path.join(documentsDirectory, 'Notes', noteFile), 'utf8'), /Public trial note round trip\./);
  await run(`(() => { const search = ${selector('#wb-notes [data-nw-search]')}; search.value = 'Public trial note round trip'; search.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await until(`${selector('#wb-notes [data-nw-list]')}.textContent.includes('Public tri')`);
  await nav('home');
  await until(`!${selector('#wb-home')}.hidden`);

  const report = { isolatedDataRoot: true, startupSkip: true, clock: true, missingTranslationAssets: translationUnavailable, missingDictionary: dictionaryUnavailable, noteViaUiAndPreload: true, navigation: true };
  await writeFile(path.join(fixtureRoot, 'Public_Core_Verification_CodexV1.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PUBLIC_CORE_VERIFY_OK', JSON.stringify(report));
}
