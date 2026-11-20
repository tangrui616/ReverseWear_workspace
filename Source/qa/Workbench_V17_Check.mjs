import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { readOuroboros, waitForOuroboros } from './Ouroboros_Check_CodexV9.0.1.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeDocx() {
  const longText = Array.from({ length: 80 }, (_, index) => `<w:p><w:r><w:t>Reading scroll line ${index + 1} keeps document height measurable.</w:t></w:r></w:p>`).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>V17 DOCX 阅读验收</w:t></w:r></w:p>
<w:p><w:r><w:t>This paragraph is selectable and can be translated.</w:t></w:r></w:p>
<w:p><w:r><w:t>body</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>样本</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格保留</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>${longText}<w:sectPr/></w:body></w:document>`;
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', documentXml],
  ];
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const source = Buffer.from(content);
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function runV17Check(win, { app, workbench, fixtureRoot }) {
  assert.ok(win && workbench && fixtureRoot, 'V17 验收需要窗口、工作区和临时数据目录。');
  const root = path.resolve(fixtureRoot);
  const fixtures = path.join(root, 'V17Fixtures');
  const screenshots = path.join(root, 'V17Screenshots');
  await Promise.all([mkdir(fixtures, { recursive: true }), mkdir(screenshots, { recursive: true })]);
  const markdownPath = path.join(fixtures, 'V17_Markdown_Read_Check.md');
  const docxPath = path.join(fixtures, 'V17_Docx_Read_Check.docx');
  await Promise.all([
    writeFile(markdownPath, '# V17 Markdown 阅读验收\n\nThis Markdown paragraph is selectable and can be translated.\n\n| 字段 | 内容 |\n| --- | --- |\n| 表格 | 保留 |\n\n' + Array.from({ length: 80 }, (_, index) => `Reading scroll line ${index + 1} keeps document height measurable.`).join('\n\n')),
    writeFile(docxPath, makeDocx()),
  ]);

  const imported = await workbench.importFiles([markdownPath, docxPath]);
  assert.equal(imported.errors.length, 0, 'Markdown 和 DOCX 测试文件应导入成功。');
  const files = await workbench.listFiles();
  const markdown = files.find(file => file.name === path.basename(markdownPath));
  const docx = files.find(file => file.name === path.basename(docxPath));
  assert.ok(markdown?.isMarkdown && docx?.isDocx, '文件库应正确识别 Markdown 和 DOCX。');
  assert.equal((await workbench.getDocument(markdown.id)).contents.toString('utf8').includes('selectable'), true);
  assert.equal((await workbench.getDocument(docx.id)).contents.subarray(0, 2).toString(), 'PK');

  const inspect = source => win.webContents.executeJavaScript(source, true);
  const click = selector => inspect(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const el = selector => `document.querySelector(${JSON.stringify(selector)})`;
  async function until(expression, label, timeout = 18000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await inspect(expression)) return;
      const previewError = await inspect(`document.querySelector('.wb-pdf-reader-tab:not([hidden]) .document-reader__error')?.textContent || ''`);
      if (previewError) throw new Error(`V17 文档预览失败：${label}，${previewError}`);
      await delay(80);
    }
    const diagnostic = await inspect(`(() => {
      const active = document.querySelector('.wb-pdf-reader-tab:not([hidden])');
      return active?.querySelector('.document-reader__error, [data-pdf-view] .workbench-pdf__status')?.textContent || '';
    })()`);
    throw new Error(`V17 验收等待超时：${label}${diagnostic ? `，阅读区信息：${diagnostic}` : ''}`);
  }
  const nav = view => click(`.wb-nav [data-wb-nav="${view}"]`);
  await nav('files');
  await until(`${el('[data-file-list]')}?.textContent.includes(${JSON.stringify(markdown.name)}) && ${el('[data-file-list]')}?.textContent.includes(${JSON.stringify(docx.name)})`, '文件列表显示文档');

  async function openDocument(file, expectedText) {
    if (await inspect(`${el('[data-file-overview]')}?.hidden`)) {
      await click('[data-file-back]');
      await until(`!${el('[data-file-overview]')}.hidden`, '返回文件列表');
    }
    await inspect(`(() => {
      const row = [...document.querySelectorAll('[data-file-list] article')].find(item => item.textContent.includes(${JSON.stringify(file.name)}));
      const button = row?.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await until(`${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.textContent.includes(${JSON.stringify(expectedText)})`, file.name + ' 渲染');
    const selected = await inspect(`(() => {
      const article = document.querySelector('.wb-pdf-reader-tab:not([hidden]) .document-reader__content');
      const text = article?.querySelector('p') || article?.querySelector('h1');
      if (!text) return '';
      const range = document.createRange(); range.selectNodeContents(text);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })()`);
    assert.ok(selected.length > 4, `${file.name} 正文应可选择。`);
    return selected;
  }

  const selectedMarkdown = await openDocument(markdown, 'V17 Markdown 阅读验收');
  assert.ok(await inspect(`${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.querySelector('table')`), 'Markdown 表格应保留结构。');
  const selectedDocx = await openDocument(docx, 'V17 DOCX 阅读验收');
  assert.ok(await inspect(`${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.querySelector('table')`), 'DOCX 表格应保留结构。');
  assert.notEqual(selectedMarkdown, selectedDocx);
  const tabEvidence = await inspect(`(() => ({
    count: document.querySelectorAll('[data-file-tabs] [role=tab], [data-file-tabs] button').length,
    labels: document.querySelector('[data-file-tabs]')?.textContent || '',
  }))()`);
  assert.ok(tabEvidence.count >= 2, 'Markdown 与 DOCX 应各自保留阅读标签。');
  assert.ok(tabEvidence.labels.includes(markdown.name) && tabEvidence.labels.includes(docx.name), '标签应显示对应文件。');
  await inspect(`(() => {
    [...document.querySelectorAll('[data-file-tabs] .wb-file-tab-label')].find(button => button.textContent.includes(${JSON.stringify(markdown.name)}) || button.title === ${JSON.stringify(markdown.name)})?.click();
  })()`);
  await until(`${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.textContent.includes('V17 Markdown 阅读验收')`, 'Markdown 标签切换恢复正文');
  await inspect(`(() => {
    [...document.querySelectorAll('[data-file-tabs] .wb-file-tab-label')].find(button => button.textContent.includes(${JSON.stringify(docx.name)}) || button.title === ${JSON.stringify(docx.name)})?.click();
  })()`);
  await until(`${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.textContent.includes('V17 DOCX 阅读验收')`, 'DOCX 标签切换恢复正文');

  const docViewport = '.wb-pdf-reader-tab:not([hidden]) .document-reader__viewport';
  const docWheel = await inspect(`(() => { const rect = ${el(docViewport)}.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), height: Math.round(rect.height) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: docWheel.x, y: docWheel.y, deltaY: -Math.max(120, Math.round(docWheel.height * 0.7)), deltaX: 0 });
  await until(`${el(docViewport)}.scrollTop > 0`, 'DOCX 普通滚轮纵向滚动');
  const zoomLabel = el('.wb-pdf-reader-tab:not([hidden]) .document-reader__zoom span');
  const docZoomBefore = await inspect(`${zoomLabel}?.textContent`);
  assert.equal(docZoomBefore, '100%', 'DOCX 默认缩放为 100%');
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: docWheel.x, y: docWheel.y, deltaY: 120, deltaX: 0, modifiers: ['control'] });
  await until(`Number.parseInt(${zoomLabel}?.textContent, 10) > 100`, 'DOCX Ctrl+滚轮缩放');
  const docZoomAfter = await inspect(`${zoomLabel}?.textContent`);
  assert.ok(Number.parseInt(docZoomAfter, 10) > 100, 'DOCX Ctrl+滚轮应放大正文');

  const readerWindowSize = win.getSize();
  win.setSize(720, 620);
  await until('Math.abs(innerWidth - 720) <= 3 && Math.abs(innerHeight - 620) <= 3', '阅读区 720×620 窗口');
  const translationInput = await inspect(`(() => {
    const article = document.querySelector('.wb-pdf-reader-tab:not([hidden]) .document-reader__content');
    const paragraph = [...(article?.querySelectorAll('p') || [])].find(item => item.textContent.trim() === 'body');
    if (!paragraph) return '';
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  })()`);
  assert.equal(translationInput, 'body', 'DOCX 中的词汇应可选择。');
  const translateButton = await inspect(`${el('.wb-pdf-reader-tab:not([hidden]) [data-reader-translate]')}?.outerHTML || ''`);
  assert.ok(translateButton, '阅读区应有可调用的选区翻译入口。');
  const translateButtonLayout = await inspect(`(() => {
    const button = document.querySelector('.wb-pdf-reader-tab:not([hidden]) [data-reader-translate]');
    const style = button && getComputedStyle(button);
    const bounds = button?.getBoundingClientRect();
    return button && { width: bounds.width, clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      whiteSpace: style.whiteSpace, writingMode: style.writingMode, display: style.display, flexShrink: style.flexShrink };
  })()`);
  assert.ok(translateButtonLayout.width >= 110 && translateButtonLayout.whiteSpace === 'nowrap' &&
    translateButtonLayout.writingMode === 'horizontal-tb' && translateButtonLayout.flexShrink === '0',
  '阅读翻译按钮文字应保持横向完整显示。');
  await click('.wb-pdf-reader-tab:not([hidden]) [data-reader-translate]');
  await until(`${el('.wb-pdf-reader-tab:not([hidden]) [data-inline-output] .translation-dictionary-entry')}`, '本地词典展示译文', 90000);
  const translationText = await inspect(`${el('.wb-pdf-reader-tab:not([hidden]) [data-inline-output]')}.textContent`);
  assert.ok(translationText && !/正在|翻译失败/.test(translationText), '右侧应显示词典结果。');
  await writeFile(path.join(screenshots, 'reader_translation_720x620.png'), (await win.capturePage()).toPNG());
  win.setSize(...readerWindowSize);

  const translationApi = 'window.stilltimeDesktop.translation';
  const localModels = await inspect(`${translationApi}.availableModels()`);
  const sentenceModel = localModels.models.find(model => model.available && model.directions.includes('en-zh') && model.directions.includes('zh-en'));
  assert.ok(sentenceModel, '验收环境应提供至少一个双向本地句子翻译模型。');
  const englishSentence = 'The patient reported gradual improvement.';
  const englishTranslation = await inspect(`${translationApi}.translate(${JSON.stringify({ text: englishSentence, model: sentenceModel.id, direction: 'en-zh' })})`);
  assert.ok(/\p{Script=Han}/u.test(englishTranslation.text), '英译中句子应返回中文译文。');
  const chineseSentence = '患者报告逐渐改善。';
  const chineseTranslation = await inspect(`${translationApi}.translate(${JSON.stringify({ text: chineseSentence, model: sentenceModel.id, direction: 'zh-en' })})`);
  assert.ok(/[A-Za-z]{3}/.test(chineseTranslation.text), '中译英句子应返回英文译文。');
  const englishLookup = await inspect(`${translationApi}.lookup(${JSON.stringify({ text: 'body', direction: 'en-zh' })})`);
  const chineseLookup = await inspect(`${translationApi}.lookup(${JSON.stringify({ text: '身体', direction: 'zh-en' })})`);
  assert.ok(englishLookup.entries?.length && chineseLookup.entries?.length, '英汉双向本地词典都应返回词条。');

  const readerNoteBody = 'V17 DOCX 阅读笔记保存与重新打开验收。';
  const readerNoteTitle = 'V17阅读笔记';
  const docxNotePanel = '.wb-pdf-reader-tab:not([hidden]) [data-pdf-notes]';
  await inspect(`(() => {
    const panel = document.querySelector(${JSON.stringify(docxNotePanel)});
    const editor = panel?.querySelector('[data-nw-body]');
    if (!editor) return false;
    editor.value = ${JSON.stringify('# ' + readerNoteTitle + '\n\n' + readerNoteBody)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    panel.querySelector('[data-nw-save]')?.click();
    return true;
  })()`);
  await until(`${el(`${docxNotePanel} [data-nw-metadata]`)}?.open`, 'DOCX 阅读笔记元数据');
  await inspect(`document.querySelector(${JSON.stringify(`${docxNotePanel} [data-nw-metadata-form] [type=submit]`)}).click()`);
  await until(`!${el(`${docxNotePanel} [data-nw-metadata]`)}.open`, 'DOCX 阅读笔记保存完成');
  const savedReaderNote = (await workbench.listNotes({ kind: 'note', fileId: docx.id })).find(item => item.title === readerNoteTitle);
  assert.ok(savedReaderNote?.body.includes(readerNoteBody), 'DOCX 阅读笔记应以文件 ID 归档。');
  await inspect(`(() => {
    const panel = document.querySelector(${JSON.stringify(docxNotePanel)});
    const tab = [...(panel?.querySelectorAll('.note-workspace__tab') || [])].find(item => item.querySelector('.note-workspace__tab-title')?.textContent === ${JSON.stringify(readerNoteTitle)});
    tab?.querySelector('.note-workspace__tab-close')?.click();
  })()`);
  await nav('notes');
  await until(`${el('#wb-notes')} && !${el('#wb-notes')}.hidden`, '笔记页打开');
  await inspect(`[...document.querySelectorAll('#wb-notes [data-nw-categories] button')]
    .find(button => button.textContent === '阅读笔记').click()`);
  await until(`${el('#wb-notes [data-nw-list]')}?.textContent.includes(${JSON.stringify(readerNoteTitle)})`, 'DOCX 笔记出现在阅读归档');
  await inspect(`[...document.querySelectorAll('#wb-notes [data-nw-list] .note-workspace__archive-open')]
    .find(button => button.textContent.includes(${JSON.stringify(readerNoteTitle)})).click()`);
  await until(`${el('#wb-notes [data-nw-body]')}?.value.includes(${JSON.stringify(readerNoteBody)})`, 'DOCX 阅读笔记重新打开');
  await click('#wb-notes [data-nw-open-source]');
  await until(`!${el('#wb-files')}?.hidden && ${el('.wb-pdf-reader-tab:not([hidden]) .document-reader__content')}?.textContent.includes('V17 DOCX 阅读验收')`, 'DOCX 阅读笔记打开原文件');
  await nav('notes');
  await inspect(`[...document.querySelectorAll('#wb-notes [data-nw-categories] button')]
    .find(button => button.textContent === '笔记').click()`);
  const tagValue = 'V17_自动标签验收';
  const firstNoteBody = '# V17 标签验收\n\n保存标签后应进入最近标签列表。';
  const secondNoteBody = '# V17 标签建议复核\n\n验证已保存标签建议。';
  await click('#wb-notes [data-nw-new]');
  await inspect(`(() => {
    const editor = document.querySelector('#wb-notes [data-nw-body]');
    editor.value = ${JSON.stringify(firstNoteBody)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#wb-notes [data-nw-save]').click();
  })()`);
  await until(`${el('#wb-notes [data-nw-metadata]')}.open`, '笔记元数据弹窗');
  await inspect(`(() => {
    const form = document.querySelector('#wb-notes [data-nw-metadata-form]');
    form.elements.tags.value = ${JSON.stringify(tagValue)};
    form.elements.tags.dispatchEvent(new Event('input', { bubbles: true }));
    form.querySelector('[type=submit]').click();
  })()`);
  await until(`!${el('#wb-notes [data-nw-metadata]')}.open`, '标签笔记保存');
  await click('#wb-notes [data-nw-new]');
  await inspect(`(() => {
    const editor = document.querySelector('#wb-notes [data-nw-body]');
    editor.value = ${JSON.stringify(secondNoteBody)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#wb-notes [data-nw-save]').click();
  })()`);
  await until(`${el('#wb-notes [data-nw-metadata]')}.open`, '第二条笔记元数据弹窗');
  await inspect(`(() => {
    const input = document.querySelector('#wb-notes [data-nw-metadata-form] [name=tags]');
    input?.focus();
    input.value = 'V17_自动';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  try {
    await until(`[...document.querySelectorAll('#wb-notes .tag-suggestions__list:not([hidden]) [role=option]')].some(option => option.textContent === ${JSON.stringify(tagValue)})`, '最近标签建议', 3000);
  } catch (error) {
    const detail = await inspect(`(async () => {
      const field = document.querySelector('#wb-notes [name=tags]');
      const focused = document.activeElement;
      const overlays = [...document.querySelectorAll('dialog[open]')].map(value => ({ id: value.id, section: value.closest('section')?.id }));
      return { active: focused?.outerHTML.slice(0,200), expanded: field?.getAttribute('aria-expanded'), field: field?.value,
        caret: field?.selectionStart, mounted: field?.parentElement?.className, overlays, recent: await window.stilltimeDesktop.recentTags.list() };
    })()`);
    console.error('最近标签界面状态', detail);
    throw error;
  }
  const suggestions = await inspect(`[...document.querySelectorAll('.tag-suggestions__list [role=option]')].some(option => option.textContent === ${JSON.stringify(tagValue)})`);
  assert.equal(suggestions, true, '最近标签应出现在输入建议中。');
  await inspect(`(() => {
    const form = document.querySelector('#wb-notes [data-nw-metadata-form]');
    form.elements.tags.value = ${JSON.stringify(tagValue)};
    form.querySelector('[type=submit]').click();
  })()`);
  await until(`!${el('#wb-notes [data-nw-metadata]')}.open`, '建议复核笔记保存');

  const sectionedLink = await workbench.saveLink({
    url: 'https://example.invalid/v17-library-check', title: 'V17 链接分区验收',
    tags: ['V17 分区验收'], note: '链接应在对应标签分区列出。',
  });
  assert.equal(sectionedLink.duplicate, false);
  await nav('links');
  await until(`document.querySelector('#wb-links') && !document.querySelector('#wb-links').hidden`, '链接库打开');
  await until(`${el('#wb-links .web-collection__sections')}?.textContent.includes('V17 分区验收')`, '链接标签异步加载');
  const sectionAvailable = await inspect(`${el('#wb-links .web-collection__sections')}?.textContent.includes('V17 分区验收')`);
  assert.equal(sectionAvailable, true, '链接标签应形成可筛选分区。');
  await inspect(`(() => {
    [...document.querySelectorAll('#wb-links .web-collection__sections button')].find(item => item.textContent.trim() === 'V17 分区验收')?.click();
  })()`);
  await until(`document.querySelector('#wb-links .web-collection__list')?.textContent.includes('V17 链接分区验收')`, '标签过滤出对应收藏');
  const selectedTag = await inspect(`(() => {
    const button = [...document.querySelectorAll('#wb-links .web-collection__sections button')].find(item => item.textContent.trim() === 'V17 分区验收');
    const entry = [...document.querySelectorAll('#wb-links .web-collection__entry')].find(item => item.textContent.includes('V17 链接分区验收'));
    return button?.getAttribute('aria-current') === 'true' && entry?.getAttribute('aria-current') === 'false';
  })()`);
  assert.equal(selectedTag, true, '选中标签时应标记筛选分区并列出匹配收藏。');
  await click('#wb-links .web-collection__entry');
  await until(`document.querySelector('#wb-links [data-nw-body]') && document.querySelector('#wb-links [data-nw-list-toggle]')`, '收藏打开关联笔记工作区');
  const linkWorkspaceActions = await inspect(`(() => {
    const workspace = document.querySelector('#wb-links');
    return workspace.querySelector('[data-nw-save]')?.textContent.includes('保存') &&
      workspace.querySelector('[data-nw-new]') && workspace.querySelector('[data-nw-list-toggle]')?.textContent.includes('笔记列表');
  })()`);
  assert.equal(linkWorkspaceActions, true, '打开收藏后应提供保存笔记、新建笔记及笔记列表入口。');

  const previousAppearance = await inspect('window.stilltimeDesktop.loadAppearance()');
  async function chooseTheme(mode) {
    if (await inspect(`${el('#wb-appearance-panel')}?.hidden`)) await click('#wb-appearance');
    await until(`!${el('#wb-appearance-panel')}.hidden`, '外观面板打开');
    await click(`[data-mode-choice="${mode}"]`);
    const expected = mode === 'system' ? await inspect("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'") : mode;
    await until(`document.documentElement.dataset.theme === ${JSON.stringify(expected)} && ${el(`[data-mode-choice="${mode}"]`)}?.getAttribute('aria-pressed') === 'true'`, `${mode} 主题切换`);
    if (!(await inspect(`${el('#wb-appearance-panel')}?.hidden`))) await click('#wb-appearance');
  }
  const debuggerSession = win.webContents.debugger;
  const ownsDebugger = !debuggerSession.isAttached();
  if (ownsDebugger) debuggerSession.attach('1.3');
  let emulatedViewport = false;
  async function setViewport(width, height) {
    if (emulatedViewport) {
      await debuggerSession.sendCommand('Emulation.clearDeviceMetricsOverride');
      emulatedViewport = false;
      await delay(160);
    }
    win.setSize(width, height);
    await delay(350);
    const nativeViewport = await inspect('({ width: window.innerWidth, height: window.innerHeight })');
    let method = 'native';
    if (nativeViewport.width !== width || nativeViewport.height !== height) {
      await debuggerSession.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      emulatedViewport = true;
      method = 'cdp-emulation';
    }
    await until(`window.innerWidth === ${width} && window.innerHeight === ${height}`, `${width}×${height} 视口`);
    return { nativeViewport, method };
  }
  async function captureViewport(width, height, emulated) {
    if (emulated) {
      const { data } = await debuggerSession.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      });
      const image = Buffer.from(data, 'base64');
      assert.equal(image.readUInt32BE(16), width, 'CDP 截图宽度应匹配 CSS 视口。');
      assert.equal(image.readUInt32BE(20), height, 'CDP 截图高度应匹配 CSS 视口。');
      return image;
    }
    const image = await win.capturePage();
    assert.ok(!image.isEmpty());
    return image.toPNG();
  }
  const layoutEvidence = [];
  try {
    for (const mode of ['light', 'dark']) {
      await chooseTheme(mode);
      for (const [width, height] of [[1920, 1017], [1308, 884], [720, 620]]) {
        const viewport = await setViewport(width, height);
        await nav('home');
        await until(`!${el('#wb-home')}.hidden && ${el('.wb-home-scene')}?.getBoundingClientRect().width > 0`, '首页布局可见');
        await inspect(`new Promise(resolve => {
          const target = document.querySelector('.wb-home-scene');
          target?.scrollIntoView({ block: 'center', inline: 'nearest' });
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)));
        })`);
        win.focus();
        win.webContents.focus();
        const frameBaseline = Number(await readOuroboros(win, 'window.__frames || 0')) || 0;
        try {
          await waitForOuroboros(() => readOuroboros(win,
            `window.__frames > ${frameBaseline} && __ouro.S.night === ${mode === 'dark'}`), '首页获得焦点后动画帧与主题推进');
        } catch (error) {
          console.error('V17 首页动画诊断', await inspect(`(() => {
            const target = document.querySelector('.wb-home-scene');
            const rect = target?.getBoundingClientRect();
            return { visible: document.visibilityState, focus: document.hasFocus(),
              card: rect && { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
              iframe: target?.querySelector('iframe')?.getBoundingClientRect().toJSON() };
          })()`), await readOuroboros(win,
            '({ frames: window.__frames, night: window.__ouro?.S.night, running: window.__running ?? window.running, load: document.querySelector("#load")?.textContent })'));
          throw error;
        }
        const homeLayout = await inspect(`(() => {
          const scene = document.querySelector('.wb-home-scene')?.getBoundingClientRect();
          const card = document.querySelector('.wb-home-scene');
          const iframe = card?.querySelector('iframe')?.getBoundingClientRect();
          const timer = document.querySelector('.wb-home-stopwatch')?.getBoundingClientRect();
          return {
            fits: document.documentElement.scrollWidth <= window.innerWidth + 2,
            scene: scene && { left: scene.left, right: scene.right, width: scene.width, height: scene.height },
            animation: iframe && { width: iframe.width, height: iframe.height,
              widthDelta: Math.abs(iframe.width - card.clientWidth), heightDelta: Math.abs(iframe.height - card.clientHeight),
              overflowX: card.scrollWidth - card.clientWidth, overflowY: card.scrollHeight - card.clientHeight },
            timer: timer && { left: timer.left, right: timer.right, width: timer.width },
          };
        })()`);
        assert.equal(homeLayout.fits, true, `${mode} ${width}×${height} 首页不应横向溢出。`);
        assert.ok(homeLayout.scene?.width > 0 && homeLayout.scene.height > 0, '动画卡片应有可用的宽、高。');
        assert.ok(homeLayout.animation?.width > 0 && homeLayout.animation.height > 0 &&
          homeLayout.animation.widthDelta <= 2 && homeLayout.animation.heightDelta <= 2 &&
          homeLayout.animation.overflowX <= 2 && homeLayout.animation.overflowY <= 2,
        '衔尾蛇动画应填满卡片且卡片内容不得溢出。');
        assert.ok(homeLayout.timer?.width > 0 && homeLayout.timer.right <= width + 2, '计时卡片应留在可视区域内。');
        let image = await captureViewport(width, height, viewport.method === 'cdp-emulation');
        await writeFile(path.join(screenshots, `${mode}_${width}x${height}_home.png`), image);

        await nav('links');
        await until(`!${el('#wb-links')}.hidden && ${el('#wb-links .web-collection__columns')}?.getBoundingClientRect().width > 0`, '网页收藏布局可见');
        await until(`${el('#wb-links .web-collection__directory')}?.getBoundingClientRect().width > 0 &&
          ${el('#wb-links .web-collection__notes')}?.getBoundingClientRect().width > 0 &&
          ${el('#wb-links .web-collection__page')}?.getBoundingClientRect().width > 0`, '收藏目录、笔记与网页区域布局完成');
        const linkLayout = await inspect(`(() => {
          const layout = document.querySelector('#wb-links .web-collection__columns')?.getBoundingClientRect();
          const directory = document.querySelector('#wb-links .web-collection__directory')?.getBoundingClientRect();
          const notes = document.querySelector('#wb-links .web-collection__notes')?.getBoundingClientRect();
          const page = document.querySelector('#wb-links .web-collection__page')?.getBoundingClientRect();
          return {
            fits: document.documentElement.scrollWidth <= window.innerWidth + 2,
            layout: layout && { left: layout.left, right: layout.right, width: layout.width },
            directory: directory && { left: directory.left, right: directory.right, width: directory.width },
            notes: notes && { left: notes.left, right: notes.right, width: notes.width },
            page: page && { left: page.left, right: page.right, width: page.width },
          };
        })()`);
        assert.equal(linkLayout.fits, true, `${mode} ${width}×${height} 网页收藏不应横向溢出。`);
        assert.ok(linkLayout.layout?.width > 0 && linkLayout.directory?.width > 0 && linkLayout.notes?.width > 0 && linkLayout.page?.width > 0,
          '收藏目录、关联笔记及网页区域均应可见。');
        assert.ok(linkLayout.layout.right <= width + 2 && linkLayout.page.right <= width + 2, '网页收藏各区应在窗口范围内。');
        image = await captureViewport(width, height, viewport.method === 'cdp-emulation');
        await writeFile(path.join(screenshots, `${mode}_${width}x${height}_links.png`), image);
        layoutEvidence.push({ mode, width, height, viewport, home: homeLayout, links: linkLayout, screenshots: true });
      }
    }
  } finally {
    try {
      await chooseTheme(previousAppearance.mode);
    } finally {
      try {
        if (emulatedViewport) await debuggerSession.sendCommand('Emulation.clearDeviceMetricsOverride');
      } finally {
        if (ownsDebugger && debuggerSession.isAttached()) debuggerSession.detach();
      }
    }
  }

  const evidence = {
    documents: {
      markdown: true, docx: true, selectable: true, tables: true, tabs: true,
      translatedSelection: true, translationButtonHorizontal: true, readingNoteRoundTrip: true,
    },
    translation: {
      sentenceDirections: ['en-zh', 'zh-en'], dictionaryDirections: ['en-zh', 'zh-en'], model: sentenceModel.id,
    },
    recentTags: { persistedAndSuggested: true, value: tagValue },
    links: { taggedSection: true, rowVisible: true },
    layout: layoutEvidence,
  };
  await writeFile(path.join(root, 'Workbench_V17_Verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('WORKBENCH_V17_VERIFY_OK', JSON.stringify(evidence));
  win.close();
}
