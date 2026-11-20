import { classifyTranslationInput, cleanSelectedText, inferDirection, normalizeDictionaryEntries, normalizeModelList } from './translation.mjs';

export function mountHomeTranslation({ container, api, clipboard, errorText }) {
  container.setAttribute('aria-labelledby', 'wb-home-translation-title');
  container.innerHTML = `
    <header><h2 id="wb-home-translation-title">翻译</h2></header>
    <div class="wb-home-translation__tools">
      <label>方向<select data-home-tr-direction><option value="auto">自动</option><option value="en-zh">英 → 中</option><option value="zh-en">中 → 英</option></select></label>
      <label>模型<select data-home-tr-model disabled><option value="">按需读取</option></select></label>
      <button type="button" class="wb-button wb-primary" data-home-tr-submit disabled>翻译</button>
    </div>
    <div class="wb-home-translation__fields">
      <div class="wb-home-translation__field">
        <div><label for="wb-home-tr-source">原文</label><button class="wb-button" type="button" data-home-tr-source-copy aria-label="复制原文">复制</button><button class="wb-button" type="button" data-home-tr-source-paste aria-label="粘贴原文">粘贴</button></div>
        <textarea id="wb-home-tr-source" data-home-tr-source rows="2" maxlength="16000" placeholder="输入文字"></textarea>
      </div>
      <div class="wb-home-translation__field">
        <div><label for="wb-home-tr-output">译文</label><button class="wb-button" type="button" data-home-tr-result-copy aria-label="复制译文">复制</button><button class="wb-button" type="button" data-home-tr-result-paste aria-label="粘贴译文">粘贴</button></div>
        <textarea id="wb-home-tr-output" data-home-tr-output rows="2" placeholder="译文显示在这里"></textarea>
      </div>
    </div>
    <div class="wb-home-translation__feedback">
      <p data-home-tr-status role="status" aria-live="polite"></p>
      <p data-home-tr-terms hidden></p>
    </div>`;
  const $ = key => container.querySelector('[data-home-tr-' + key + ']');
  const source = $('source');
  const output = $('output');
  const direction = $('direction');
  const modelSelect = $('model');
  const submit = $('submit');
  const status = $('status');
  const terms = $('terms');
  let models = [];
  let modelRequest;
  let modelsChecked = false;
  let modelError = '';
  let preferredModel = 'argos';
  let generation = 0;
  let busy = false;

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.title = message;
    status.classList.toggle('is-error', isError);
  }

  function resolvedDirection() {
    return direction.value === 'auto' ? inferDirection(source.value) : direction.value;
  }

  function renderModels() {
    const language = resolvedDirection();
    const options = models.map(model => {
      const supported = !model.directions.length || model.directions.includes(language);
      const available = model.available && supported;
      const option = new Option(model.label, model.id);
      option.disabled = !available;
      if (!available) option.text += supported ? '（不可用）' : '（不支持此方向）';
      return option;
    });
    const chosen = [preferredModel, 'argos'].map(id => options.find(option => option.value === id && !option.disabled))
      .find(Boolean) ?? options.find(option => !option.disabled);
    const placeholder = new Option(modelsChecked ? '无可用模型' : '按需读取', '');
    placeholder.disabled = true;
    modelSelect.replaceChildren(...(chosen ? options : [placeholder, ...options]));
    modelSelect.value = chosen?.value ?? '';
    modelSelect.disabled = !chosen;
  }

  function loadModels() {
    modelsChecked = true;
    modelRequest ??= api.availableModels().then(result => {
      if (result?.error) throw new Error(result.error);
      models = normalizeModelList(result);
      modelError = '';
      if (!models.some(model => model.available)) modelRequest = undefined;
      renderModels();
    }).catch(error => {
      modelError = errorText(error);
      modelRequest = undefined;
      renderModels();
    });
    return modelRequest;
  }

  function updateSubmit() {
    submit.disabled = busy || !source.value.trim();
  }

  function edited() {
    generation++;
    terms.hidden = true;
    showStatus(busy ? '内容已更新，可在当前请求结束后重新翻译。' : '');
    updateSubmit();
  }

  source.addEventListener('input', () => {
    edited();
    renderModels();
    if (!modelsChecked && source.value.trim()) void loadModels();
  });
  output.addEventListener('input', edited);
  direction.addEventListener('change', () => {
    edited();
    renderModels();
    if (!modelsChecked && source.value.trim()) void loadModels();
  });
  modelSelect.addEventListener('change', () => {
    preferredModel = modelSelect.value || 'argos';
    edited();
  });

  async function handleClipboard(field, label, paste) {
    const token = generation;
    try {
      if (paste) {
        const value = await clipboard.readText();
        if (!value) throw new Error('系统剪贴板没有文字。');
        if (token !== generation) return;
        const start = field.selectionStart;
        const end = field.selectionEnd;
        const limit = field.maxLength;
        const insertion = limit < 0 ? value : value.slice(0, Math.max(0, limit - field.value.length + end - start));
        field.setRangeText(insertion, start, end, 'end');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        showStatus(insertion.length < value.length ? label + '已达到 16000 字符上限' : '已粘贴' + label);
      } else {
        const value = field.value.slice(field.selectionStart, field.selectionEnd) || field.value;
        if (!value) throw new Error(label + '为空。');
        await clipboard.writeText(value);
        if (token === generation) showStatus('已复制' + label);
      }
    } catch (error) {
      if (token === generation) showStatus(label + (paste ? '粘贴失败：' : '复制失败：') + errorText(error), true);
    }
  }

  async function translate() {
    const text = cleanSelectedText(source.value);
    if (!text || busy) return;
    const token = ++generation;
    const language = resolvedDirection();
    const isWord = classifyTranslationInput(text) === 'word';
    busy = true;
    updateSubmit();
    terms.hidden = true;
    showStatus(isWord ? '正在查询本地词典…' : '正在准备本地翻译…');
    const pendingModels = loadModels();
    let dictionaryError = '';
    try {
      if (isWord) {
        try {
          const result = await api.lookup({ text, direction: language, sentence: text });
          if (token !== generation) return;
          const entry = normalizeDictionaryEntries(result).find(item => item.translations.length || item.definitions.length);
          if (entry) {
            output.value = [...entry.translations, ...entry.definitions].join('\n');
            showStatus(result.vocabulary ? '已查词并加入生词本' : '本地词典查询完成');
            return;
          }
        } catch (error) {
          dictionaryError = errorText(error);
        }
      }
      await pendingModels;
      if (token !== generation) return;
      const model = modelSelect.value;
      if (!model) {
        const reason = modelError || models.map(item => item.reason).find(Boolean);
        const unavailable = '当前方向没有可用的离线翻译模型' + (reason ? '：' + reason : '。');
        throw new Error(dictionaryError ? dictionaryError + '。' + unavailable : unavailable);
      }
      showStatus(dictionaryError ? '词典暂不可用，正在使用模型翻译…' : '正在本地翻译…');
      const result = await api.translate({ text, model, direction: language, sentence: text });
      if (token !== generation) return;
      output.value = result?.text ?? '';
      const matches = result?.terms ?? [];
      terms.textContent = matches.length ? '术语参考 · ' + matches.map(term => term.source + ' → ' + term.target).join(' · ') : '';
      terms.hidden = !matches.length;
      showStatus(dictionaryError ? '词典暂不可用，已使用模型翻译。' : '本地翻译完成');
    } catch (error) {
      if (token === generation) showStatus('翻译失败：' + errorText(error), true);
    } finally {
      busy = false;
      updateSubmit();
    }
  }
  submit.onclick = translate;
  source.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      void translate();
    }
  });
  $('source-copy').onclick = () => handleClipboard(source, '原文', false);
  $('source-paste').onclick = () => handleClipboard(source, '原文', true);
  $('result-copy').onclick = () => handleClipboard(output, '译文', false);
  $('result-paste').onclick = () => handleClipboard(output, '译文', true);
}
