const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export function cleanSelectedText(value) {
  return String(value ?? '')
    .replace(/\u00ad/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]*\n[\t\f\v ]*/g, ' ')
    .replace(/(?<=\p{L})-\s+(?=\p{Ll})/gu, '')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .trim();
}

export function cleanPdfSelection(value, repeatedMargins = []) {
  const repeated = new Set(repeatedMargins.map(item => String(item).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()).filter(Boolean));
  const text = String(value ?? '').replace(/\u00ad/g, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const withoutRepeatedLines = lines.filter((line, index) => {
    const normalized = line.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const isEdgePageNumber = lines.length > 1 && (index === 0 || index === lines.length - 1) && /^\s*\d{1,4}\s*$/.test(line);
    return !repeated.has(normalized) && !isEdgePageNumber;
  }).join('\n');
  return cleanSelectedText(withoutRepeatedLines);
}

export function normalizeModelList(value) {
  const models = Array.isArray(value) ? value : value?.models ?? [];
  return models.map(model => typeof model === 'string'
    ? { id: model, label: model, available: true, directions: [] }
    : { id: model.id, label: model.label || model.name || model.id, available: model.available !== false, directions: model.directions ?? [], reason: model.reason || '' })
    .filter(model => model.id);
}

function entryText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return '';
  return String(value.translation ?? value.definition ?? value.meaning ?? value.text ?? value.value ?? '');
}

function entryList(value) {
  if (Array.isArray(value)) return value.map(entryText).filter(Boolean);
  if (typeof value === 'string') return value.split(/[;；\n]/).map(item => item.trim()).filter(Boolean);
  return [];
}

export function normalizeDictionaryEntries(result = {}) {
  return (result.entries ?? []).map(entry => ({
    ...entry,
    translations: entryList(entry.translations?.length ? entry.translations : entry.translation),
    definitions: entryList(entry.definitions?.length ? entry.definitions : entry.definition),
  }));
}

export function classifyTranslationInput(value) {
  const text = cleanSelectedText(value);
  if (/^[\p{Script=Han}]{1,4}$/u.test(text)) return 'word';
  if (/^[\p{L}]+(?:['’-][\p{L}]+)*$/u.test(text)) return 'word';
  return 'sentence';
}

const dateText = value => value ? new Date(value).toLocaleDateString('zh-CN') : '待安排';
export const inferDirection = value => /\p{Script=Han}/u.test(String(value ?? '')) ? 'zh-en' : 'en-zh';

export function createTranslationPanel(container, api = window.stilltimeDesktop?.translation, { openSource = null, clipboard = null } = {}) {
  if (!container || !api) throw new Error('离线翻译服务尚未连接。');
  container.classList.add('translation-panel');
  container.innerHTML = `
    <header class="translation-heading">
      <div><h1>离线翻译与词汇</h1><p>词典查询、文段翻译和复习都在本机完成。</p></div>
      <div class="translation-status" role="status" aria-live="polite">正在读取本地模型…</div>
    </header>
    <div class="translation-layout">
      <section class="translation-card translation-translate" aria-labelledby="tr-translate-title">
        <div class="translation-card-head"><div><h2 id="tr-translate-title">查词与翻译</h2></div><label>方向<select data-tr-translate-direction><option value="en-zh">英 → 中</option><option value="zh-en">中 → 英</option></select></label></div>
        <form data-tr-lookup-form><label class="translation-field-label" for="tr-source">原文</label><textarea id="tr-source" data-tr-source data-tr-query rows="4" placeholder="输入单词或句子，也可以从 PDF、笔记选中文字"></textarea>
        <div class="translation-clipboard-actions"><button type="button" data-tr-source-copy>复制原文</button><button type="button" data-tr-source-paste>粘贴原文</button></div>
        <div class="translation-model-row"><label>本地模型<select data-tr-model><option value="">正在检查可用模型…</option></select></label><button class="translation-primary" type="submit" data-tr-translate>查词 / 翻译</button></div></form>
        <section class="translation-output" aria-label="翻译结果"><div class="translation-output-head"><strong>结果</strong><span data-tr-result-kind></span><div class="translation-clipboard-actions"><button type="button" data-tr-result-copy>复制结果</button><button type="button" data-tr-output-paste>粘贴译文</button></div></div><div data-tr-lookup-result class="translation-result" aria-live="polite"><p class="translation-empty">词典或翻译结果会显示在这里。</p></div><textarea data-tr-output aria-label="译文，可直接编辑" rows="4" placeholder="译文可直接修改"></textarea><div data-tr-term-suggestions class="translation-term-suggestions" hidden></div></section>
      </section>
      <section class="translation-card translation-vocabulary" aria-labelledby="tr-vocab-title">
        <div class="translation-card-head"><div><h2 id="tr-vocab-title">生词本</h2></div><span data-tr-due class="translation-count">今日 0 词</span></div>
        <div data-tr-vocabulary class="translation-vocabulary-list"><p class="translation-empty">正在读取生词本…</p></div>
      </section>
      <section class="translation-card translation-terms" aria-labelledby="tr-terms-title">
        <div class="translation-card-head"><div><h2 id="tr-terms-title">个人术语表</h2></div></div>
        <form data-tr-term-form class="translation-term-form"><input name="source" aria-label="原词" placeholder="原词"><span aria-hidden="true">→</span><input name="target" aria-label="译词" placeholder="译词"><input name="note" aria-label="说明" placeholder="备注（可选）"><button type="submit">添加</button></form>
        <div data-tr-terms class="translation-term-list"><p class="translation-empty">正在读取术语表…</p></div>
      </section>
    </div>`;
  container.insertAdjacentHTML('beforeend', `<footer class="translation-attribution"><strong>本地资源与许可</strong><span>ECDICT（MIT） · CC-CEDICT（CC BY-SA 4.0） · Argos Translate 引擎（MIT/CC0，模型包各自许可） · Helsinki-NLP OPUS-MT（en→zh Apache-2.0，zh→en CC-BY-4.0） · Tencent Hy-MT2（Apache-2.0）</span></footer>`);

  const form = container.querySelector('[data-tr-lookup-form]');
  const lookupResult = container.querySelector('[data-tr-lookup-result]');
  const sourceText = container.querySelector('[data-tr-source]');
  const outputText = container.querySelector('[data-tr-output]');
  const translateDirection = container.querySelector('[data-tr-translate-direction]');
  const modelSelect = container.querySelector('[data-tr-model]');
  const status = container.querySelector('.translation-status');
  let disposed = false;
  let vocabulary = [];
  let terms = [];
  let translationToken = 0;
  let loadToken = 0;
  let selectedSource = null;
  let selectedSentence = '';
  let selectedTerm = '';
  let models = [];
  let modelLoadPromise = null;
  let directionManuallyChanged = false;
  let activeTermSuggestions = [];

  async function readClipboardText() {
    if (clipboard?.readText) return clipboard.readText();
    if (!navigator.clipboard?.readText) throw new Error('当前环境不允许读取系统剪贴板。');
    return navigator.clipboard.readText();
  }

  async function writeClipboardText(value) {
    if (clipboard?.writeText) return clipboard.writeText(value);
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不允许写入系统剪贴板。');
    return navigator.clipboard.writeText(value);
  }

  async function copyField(field, label) {
    const selected = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
    const value = selected || field.value;
    if (!value) { showStatus(`${label}为空，没有内容可复制`, true); return; }
    try {
      await writeClipboardText(value);
      showStatus(selected ? '已复制选中的文字' : `${label}已复制`);
    } catch (error) { showStatus(`复制失败：${error.message || '无法写入剪贴板'}`, true); }
  }

  async function pasteIntoField(field, label) {
    try {
      const value = await readClipboardText();
      if (!value) { showStatus('系统剪贴板没有文字内容', true); return; }
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.value = field.value.slice(0, start) + value + field.value.slice(end);
      if (field === outputText) field.hidden = false;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      const cursor = start + value.length;
      field.setSelectionRange(cursor, cursor);
      showStatus(`已粘贴到${label}`);
    } catch (error) { showStatus(`粘贴失败：${error.message || '无法读取剪贴板'}`, true); }
  }

  function showLookup(result, word) {
    const entries = normalizeDictionaryEntries(result);
    if (!entries.length) return false;
    lookupResult.innerHTML = entries.map(entry => `<article class="translation-dictionary-entry">
      <div class="translation-word-line"><strong>${escapeHtml(entry.word || result.query)}</strong>${entry.phonetic ? `<span>${escapeHtml(entry.phonetic)}</span>` : ''}</div>
      ${entry.translations.length ? `<ul>${entry.translations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      ${entry.definitions.length ? `<p class="translation-definition">${entry.definitions.map(escapeHtml).join('<br>')}</p>` : ''}
      ${result.vocabulary ? `<span class="translation-save-state">已加入生词本${selectedSource?.title ? ` · ${escapeHtml(selectedSource.title)}` : ''}</span>` : ''}
    </article>`).join('');
    outputText.hidden = true;
    container.querySelector('[data-tr-result-kind]').textContent = word ? '词典' : '短语';
    showStatus(`${result.vocabulary ? '已加入生词本 · ' : ''}本地词典 · ${Number(result.elapsedMs || 0).toFixed(1)} ms`);
    return true;
  }

  async function submitText(text = sourceText.value, { focusResult = false } = {}) {
    const cleaned = cleanSelectedText(text);
    if (!cleaned) return;
    const token = ++translationToken;
    const mode = classifyTranslationInput(cleaned);
    container.querySelector('[data-tr-translate]').disabled = true;
    outputText.hidden = false;
    outputText.value = '';
    lookupResult.innerHTML = '<p class="translation-empty">正在处理…</p>';
    renderTermSuggestions([]);
    showStatus(mode === 'word' ? '正在查询本地词典…' : '正在本地翻译…');
    try {
      if (mode === 'word') {
        const result = await api.lookup({ text: cleaned, direction: translateDirection.value, source: selectedSource, sentence: selectedSentence || cleaned });
        if (disposed || token !== translationToken) return;
        if (showLookup(result, true)) {
          try {
            const latestVocabulary = await api.listVocabulary();
            if (disposed || token !== translationToken) return;
            renderVocabulary(latestVocabulary);
          }
          catch { /* Keep the completed dictionary result visible. */ }
          if (focusResult) outputText.focus();
          return;
        }
      }
      if (!modelSelect.value && modelLoadPromise) {
        await modelLoadPromise;
        if (disposed || token !== translationToken) return;
      }
      if (!modelSelect.value) throw new Error('当前翻译方向没有可用的离线模型。');
      const result = await api.translate({ text: cleaned, model: modelSelect.value, direction: translateDirection.value, source: selectedSource, sentence: selectedSentence || cleaned });
      if (disposed || token !== translationToken) return;
      lookupResult.replaceChildren();
      container.querySelector('[data-tr-result-kind]').textContent = mode === 'word' ? '词典未收录 · 模型翻译' : '句子翻译';
      outputText.value = result?.text ?? '';
      renderTermSuggestions(result?.terms);
      showStatus(`本地翻译完成 · ${Number(result?.elapsedMs || 0).toFixed(1)} ms`);
      if (focusResult) outputText.focus();
    } catch (error) {
      if (disposed || token !== translationToken) return;
      lookupResult.innerHTML = `<p class="translation-error">${escapeHtml(error.message || '离线处理失败')}</p>`;
      container.querySelector('[data-tr-result-kind]').textContent = '处理失败';
      showStatus(`${mode === 'word' ? '查词或翻译' : '翻译'}失败：${error.message || '请检查本地资源'}`, true);
    } finally {
      if (!disposed && token === translationToken) container.querySelector('[data-tr-translate]').disabled = false;
    }
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function renderVocabulary(result) {
    vocabulary = Array.isArray(result) ? result : result?.entries ?? [];
    const dueCount = Array.isArray(result) ? vocabulary.length : Number(result?.dueCount ?? vocabulary.filter(item => !item.dueDate || item.dueDate <= new Date().toISOString().slice(0, 10)).length);
    container.querySelector('[data-tr-due]').textContent = `今日 ${dueCount} 词`;
    const list = container.querySelector('[data-tr-vocabulary]');
    if (!vocabulary.length) {
      list.innerHTML = '<p class="translation-empty">查过的词会自动进入生词本。</p>';
      return;
    }
    list.innerHTML = vocabulary.map(item => `<article class="translation-vocab-entry" data-vocab-id="${escapeHtml(item.id)}">
      <div><strong>${escapeHtml(item.word)}</strong><span>${escapeHtml(item.gloss || '')}</span></div>
      <p>${escapeHtml(item.original || '')}</p>
      <small>${item.sources?.[0]?.type === 'pdf' ? `PDF 第 ${escapeHtml(item.sources[0].page || '—')} 页` : '本地词典'} · 下次 ${dateText(item.dueDate)}</small>
      ${item.sources?.length ? `<div class="translation-source-list">${item.sources.map((source, index) => `<button type="button" data-vocab-source="${index}">${escapeHtml(source.title || (source.type === 'pdf' ? 'PDF' : '笔记'))}${source.page ? ` · 第 ${escapeHtml(source.page)} 页` : ''}</button>`).join('')}</div>` : ''}
      <div class="translation-review-actions" aria-label="复习评分"><button data-rating="again">忘记</button><button data-rating="hard">困难</button><button data-rating="good">记得</button><button data-rating="easy">简单</button></div>
    </article>`).join('');
  }

  function renderTerms() {
    const list = container.querySelector('[data-tr-terms]');
    if (!terms.length) { list.innerHTML = '<p class="translation-empty">添加后，翻译时会提示使用个人术语。</p>'; return; }
    list.innerHTML = terms.map(term => `<div class="translation-term-entry" data-term-id="${escapeHtml(term.id)}"><span>${escapeHtml(term.source)}</span><span aria-hidden="true">→</span><strong>${escapeHtml(term.target)}</strong><small>${escapeHtml(term.note || '')}</small><button type="button" data-remove-term aria-label="删除术语">删除</button></div>`).join('');
  }

  function renderModels(preferredModel = modelSelect.value) {
    const language = translateDirection.value;
    const options = models.map(model => {
      const directionAvailable = !model.directions.length || model.directions.includes(language);
      const enabled = model.available && directionAvailable;
      const reason = !model.available ? model.reason || '模型文件尚不可用' : !directionAvailable ? `不支持${language === 'en-zh' ? '英→中' : '中→英'}` : '';
      return `<option value="${escapeHtml(model.id)}" ${enabled ? '' : 'disabled'}>${escapeHtml(model.label)}${reason ? ` · ${escapeHtml(reason)}` : ''}</option>`;
    }).join('');
    modelSelect.innerHTML = options || '<option value="">未发现离线翻译模型</option>';
    if ([...modelSelect.options].some(option => option.value === preferredModel && !option.disabled)) modelSelect.value = preferredModel;
    else {
      const firstAvailable = [...modelSelect.options].find(option => !option.disabled && option.value);
      if (firstAvailable) modelSelect.value = firstAvailable.value;
    }
    const translateButton = container.querySelector('[data-tr-translate]');
    translateButton.disabled = ![...modelSelect.options].some(option => option.value === modelSelect.value && !option.disabled);
  }

  function renderModelsForText(text) {
    const cleaned = cleanSelectedText(text);
    if (!cleaned) return;
    translateDirection.value = inferDirection(cleaned);
    renderModels();
  }

  function renderTermSuggestions(matches = []) {
    const suggestions = container.querySelector('[data-tr-term-suggestions]');
    activeTermSuggestions = matches;
    suggestions.hidden = !matches.length;
    if (!matches.length) { suggestions.replaceChildren(); return; }
    suggestions.innerHTML = `<strong>个人术语参考 · 请人工核对和应用</strong><div>${matches.map((term, index) => `<button type="button" data-copy-term="${index}"><span>${escapeHtml(term.source)}</span><span aria-hidden="true">→</span><b>${escapeHtml(term.target)}</b><small>复制译词</small></button>`).join('')}</div>`;
  }

  async function load() {
    const token = ++loadToken;
    try {
      const modelPromise = api.availableModels();
      modelLoadPromise = modelPromise.then(normalizeModelList);
      const [modelResult, vocabularyResult, termResult] = await Promise.all([
        modelPromise, api.listVocabulary(), api.listTerms(),
      ]);
      if (disposed || token !== loadToken) return;
      const selectedModel = modelSelect.value;
      const modelList = await modelLoadPromise;
      models = modelList;
      renderModels(selectedModel);
      renderVocabulary(vocabularyResult);
      terms = Array.isArray(termResult) ? termResult : [];
      renderTerms();
      showStatus(modelList.some(model => model.available) ? `已发现 ${modelList.filter(model => model.available).length} 个可用模型` : '词典可用，当前方向没有可用模型');
    } catch (error) {
      if (disposed || token !== loadToken) return;
      showStatus(`本地服务读取失败：${error.message || '未知错误'}`, true);
      container.querySelector('[data-tr-vocabulary]').innerHTML = '<p class="translation-empty">生词本暂时无法读取。</p>';
      container.querySelector('[data-tr-terms]').innerHTML = '<p class="translation-empty">术语表暂时无法读取。</p>';
    }
  }

  async function openSelection({ text, sentence, source } = {}) {
    const cleaned = cleanSelectedText(text);
    if (!cleaned) return;
    translationToken++;
    selectedSentence = cleanSelectedText(sentence || text);
    selectedSource = source ? { ...source } : null;
    selectedTerm = cleaned;
    if (!directionManuallyChanged) translateDirection.value = inferDirection(cleaned);
    renderModels(modelSelect.value);
    sourceText.value = cleaned;
    if (source?.page && source.type === 'pdf') {
      showStatus(`已带入 ${source.title || 'PDF'} · 第 ${source.page} 页`);
    }
    void submitText(cleaned);
    if (typeof sourceText.setSelectionRange === 'function') {
      sourceText.focus();
      sourceText.setSelectionRange(sourceText.value.length, sourceText.value.length);
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void submitText();
  });
  container.querySelector('[data-tr-term-suggestions]').addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-term]');
    if (!button) return;
    const target = activeTermSuggestions[Number(button.dataset.copyTerm)]?.target;
    if (!target) return;
    try {
      await writeClipboardText(target);
      showStatus('译词已复制，可手动调整译文');
    } catch { showStatus('无法写入剪贴板，请手动复制术语表中的译词', true); }
  });
  container.querySelector('[data-tr-source-copy]').onclick = () => void copyField(sourceText, '原文');
  container.querySelector('[data-tr-source-paste]').onclick = () => void pasteIntoField(sourceText, '原文框');
  container.querySelector('[data-tr-output-paste]').onclick = () => void pasteIntoField(outputText, '译文框');
  container.querySelector('[data-tr-result-copy]').onclick = async () => {
    if (!outputText.hidden && outputText.value) {
      await copyField(outputText, '译文');
      return;
    }
    const value = lookupResult.innerText.trim();
    if (!value || value === '词典或翻译结果会显示在这里。') { showStatus('结果为空，没有内容可复制', true); return; }
    try { await writeClipboardText(value); showStatus('查询结果已复制'); }
    catch (error) { showStatus(`复制失败：${error.message || '无法写入剪贴板'}`, true); }
  };
  sourceText.addEventListener('input', () => {
    translationToken++;
    lookupResult.innerHTML = '<p class="translation-empty">确认后显示词典或翻译结果。</p>';
    outputText.value = '';
    outputText.hidden = false;
    renderTermSuggestions([]);
    container.querySelector('[data-tr-result-kind]').textContent = '';
    container.querySelector('[data-tr-translate]').disabled = false;
    if (!directionManuallyChanged) renderModelsForText(sourceText.value);
    if (selectedTerm && cleanSelectedText(sourceText.value) !== selectedTerm) {
      selectedSource = null;
      selectedSentence = '';
      selectedTerm = '';
    }
  });
  translateDirection.addEventListener('change', () => { directionManuallyChanged = true; renderModels(); });
  translateDirection.addEventListener('change', () => {
    translationToken++;
    showStatus('方向已更改，重新提交后更新结果');
  });
  modelSelect.addEventListener('change', () => {
    translationToken++;
    container.querySelector('[data-tr-translate]').disabled = !modelSelect.value;
    showStatus('模型已更改，重新提交后更新结果');
  });
  sourceText.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void submitText(); }
  });
  container.querySelector('[data-tr-vocabulary]').addEventListener('click', async event => {
    const sourceButton = event.target.closest('[data-vocab-source]');
    if (sourceButton) {
      const card = sourceButton.closest('[data-vocab-id]');
      const source = vocabulary.find(item => item.id === card?.dataset.vocabId)?.sources?.[Number(sourceButton.dataset.vocabSource)];
      if (source && openSource) {
        try {
          const opened = await openSource(source);
          if (!opened) showStatus(`无法跳回来源：${source.title || source.type}`, true);
        } catch (error) { showStatus(`跳回来源失败：${error.message || '请检查原文件'}`, true); }
      } else if (source) showStatus(`${source.title || source.type}${source.page ? ` · 第 ${source.page} 页` : ''}`);
      return;
    }
    const button = event.target.closest('[data-rating]');
    if (!button) return;
    const card = button.closest('[data-vocab-id]');
    if (!card) return;
    button.disabled = true;
    try { renderVocabulary(await api.reviewVocabulary({ id: card.dataset.vocabId, rating: button.dataset.rating })); }
    catch (error) { showStatus(`复习记录失败：${error.message || '请重试'}`, true); button.disabled = false; }
  });
  container.querySelector('[data-tr-term-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const entry = Object.fromEntries(data.entries());
    if (!entry.source.trim() || !entry.target.trim()) return;
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      terms = await api.saveTerm(entry);
      renderTerms();
      form.reset();
      showStatus('术语已保存到本地');
    } catch (error) { showStatus(`保存失败：${error.message || '请重试'}`, true); }
    finally { submit.disabled = false; }
  });
  container.querySelector('[data-tr-terms]').addEventListener('click', async event => {
    const button = event.target.closest('[data-remove-term]');
    if (!button) return;
    const id = button.closest('[data-term-id]')?.dataset.termId;
    if (!id) return;
    try { terms = await api.removeTerm(id); renderTerms(); }
    catch (error) { showStatus(`删除失败：${error.message || '请重试'}`, true); }
  });

  return { load, openSelection, dispose() { disposed = true; translationToken++; loadToken++; container.replaceChildren(); container.classList.remove('translation-panel'); } };
}

export function createInlineTranslation(container, api = window.stilltimeDesktop?.translation) {
  if (!container || !api) throw new Error('离线翻译服务尚未连接。');
  container.classList.add('translation-inline');
  container.innerHTML = `<section class="translation-inline-card" aria-label="阅读翻译">
    <div class="translation-inline-toolbar"><strong>原文与翻译</strong><label>方向<select data-inline-direction><option value="en-zh">英 → 中</option><option value="zh-en">中 → 英</option></select></label></div>
    <div data-inline-source class="translation-inline-source"><p class="translation-empty">在 PDF 中选中文本后点击翻译。</p></div>
    <div class="translation-inline-tools"><label>本地模型<select data-inline-model></select></label><button class="translation-primary" type="button" data-inline-translate disabled>重新翻译</button></div>
    <div data-inline-output class="translation-inline-output" aria-live="polite"><p class="translation-empty">译文显示在这里。</p></div>
    <div class="translation-inline-status" data-inline-status role="status"></div>
  </section>`;
  const direction = container.querySelector('[data-inline-direction]');
  const model = container.querySelector('[data-inline-model]');
  const source = container.querySelector('[data-inline-source]');
  const output = container.querySelector('[data-inline-output]');
  const status = container.querySelector('[data-inline-status]');
  const button = container.querySelector('[data-inline-translate]');
  let selected = null;
  let generation = 0;
  let disposed = false;
  let models = [];
  let modelLoadPromise = null;

  function renderModels(preferred = model.value) {
    const language = direction.value;
    model.replaceChildren(...models.map(item => {
      const supports = !item.directions.length || item.directions.includes(language);
      const available = item.available && supports;
      const suffix = available ? '' : ` · ${supports ? '不可用' : '不支持此方向'}`;
      const option = new Option(item.label + suffix, item.id);
      option.disabled = !available;
      return option;
    }));
    if ([...model.options].some(option => option.value === preferred && !option.disabled)) model.value = preferred;
    else model.value = [...model.options].find(option => !option.disabled)?.value ?? '';
    button.disabled = !selected || !model.value;
  }

  async function load() {
    try {
      modelLoadPromise ??= api.availableModels().then(normalizeModelList);
      models = await modelLoadPromise;
      if (!disposed) renderModels();
    } catch (error) {
      if (!disposed) status.textContent = `本地模型读取失败：${error.message || '请重试'}`;
    }
  }

  function renderDictionary(result, selection) {
    const entries = normalizeDictionaryEntries(result);
    if (!entries.length) return false;
    output.innerHTML = entries.map(entry => `<article class="translation-dictionary-entry"><div class="translation-word-line"><strong>${escapeHtml(entry.word || result.query)}</strong>${entry.phonetic ? `<span>${escapeHtml(entry.phonetic)}</span>` : ''}</div>${entry.translations.length ? `<ul>${entry.translations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : ''}${entry.definitions.length ? `<p class="translation-definition">${entry.definitions.map(escapeHtml).join('<br>')}</p>` : ''}${result.vocabulary ? `<span class="translation-save-state">已加入生词本${selection.source?.title ? ` · ${escapeHtml(selection.source.title)}` : ''}</span>` : ''}</article>`).join('');
    status.textContent = `本地词典${selection.source?.page ? ` · 第 ${selection.source.page} 页` : ''}`;
    return true;
  }

  async function translateSelection(selection, token) {
    if (classifyTranslationInput(selection.text) === 'word') {
      status.textContent = '正在查询本地词典…';
      try {
        const result = await api.lookup({ text: selection.text, direction: direction.value, source: selection.source, sentence: selection.sentence });
        if (disposed || token !== generation) return;
        if (renderDictionary(result, selection)) return;
      } catch (error) {
        if (disposed || token !== generation) return;
        status.textContent = `词典查询失败，改用模型翻译：${error.message || ''}`;
      }
    }
    try {
      if (!model.value && modelLoadPromise) {
        await modelLoadPromise;
        if (disposed || token !== generation) return;
        models = await modelLoadPromise;
        renderModels();
      }
      if (!model.value) throw new Error('当前方向没有可用的离线模型。');
      status.textContent = '正在本地翻译…';
      const result = await api.translate({ text: selection.text, model: model.value, direction: direction.value, source: selection.source, sentence: selection.sentence });
      if (disposed || token !== generation) return;
      output.replaceChildren();
      const translated = document.createElement('p');
      translated.className = 'translation-inline-result';
      translated.textContent = result?.text ?? '';
      output.append(translated);
      if (result?.terms?.length) {
        const terms = document.createElement('p');
        terms.className = 'translation-inline-terms';
        terms.textContent = result.terms.map(term => `${term.source} → ${term.target}`).join(' · ');
        output.append(terms);
      }
      status.textContent = `本地翻译完成${selection.source?.page ? ` · 第 ${selection.source.page} 页` : ''} · ${Number(result?.elapsedMs || 0).toFixed(1)} ms`;
    } catch (error) {
      if (disposed || token !== generation) return;
      output.innerHTML = `<p class="translation-error">${escapeHtml(error.message || '翻译失败')}</p>`;
      status.textContent = '翻译失败';
    }
  }

  async function openSelection({ text, sentence, source: origin } = {}) {
    const cleaned = cleanSelectedText(text);
    if (!cleaned) return;
    const token = ++generation;
    selected = { text: cleaned, sentence: cleanSelectedText(sentence || text), source: origin ? { ...origin } : null };
    direction.value = inferDirection(cleaned);
    source.replaceChildren();
    const original = document.createElement('p');
    original.className = 'translation-inline-original';
    original.textContent = cleaned;
    source.append(original);
    output.innerHTML = '<p class="translation-empty">正在准备翻译…</p>';
    status.textContent = origin?.page ? `${origin.title || 'PDF'} · 第 ${origin.page} 页` : '';
    renderModels();
    if (!modelLoadPromise) modelLoadPromise = api.availableModels().then(normalizeModelList);
    button.disabled = false;
    void translateSelection(selected, token);
  }

  button.addEventListener('click', () => {
    if (!selected) return;
    const token = ++generation;
    output.innerHTML = '<p class="translation-empty">正在重新处理…</p>';
    void translateSelection(selected, token);
  });
  direction.addEventListener('change', () => {
    if (!selected) return;
    generation++;
    renderModels();
    status.textContent = '方向已更改，点击「重新翻译」更新结果';
  });
  model.addEventListener('change', () => {
    if (!selected) return;
    generation++;
    button.disabled = !model.value;
    status.textContent = '模型已更改，点击「重新翻译」更新结果';
  });

  return { load, openSelection, dispose() { disposed = true; generation++; container.replaceChildren(); container.classList.remove('translation-inline'); } };
}
