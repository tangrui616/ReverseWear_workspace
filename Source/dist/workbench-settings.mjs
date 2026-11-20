import { getStartupConfig, saveStartupConfig } from './startup/config.mjs';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error) {
  return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(error);
}

export function createWorkbenchSettings(panel, {
  api = window.stilltimeDesktop,
  templateApi = api?.life,
  showNotice = () => {},
  onPreview = async () => showNotice('开屏预览尚未连接。', true),
  onTestVoice = async () => showNotice('语音试听尚未连接。', true),
} = {}) {
  if (!panel || !api?.life || !api?.loadState || !api?.saveState) throw new Error('设置服务尚未连接。');
  panel.classList.add('wb-settings');
  panel.innerHTML = `
    <header class="wb-settings__heading"><h1>设置</h1><button class="wb-button" type="button" data-risk-open="mirror">AI 审核</button></header>
    <section class="wb-settings__startup" aria-label="开屏动画设置">
      <div class="wb-settings__section-heading"><h2>开屏动画</h2><div class="wb-settings__startup-actions"><button type="button" data-startup-preview>立即预览</button><button type="button" data-startup-test-voice>试听语音</button></div></div>
      <div class="wb-settings__startup-grid" data-startup-controls>
        <fieldset><legend>播放</legend>
          <label><input type="checkbox" data-startup="enabled">启用开屏</label>
          <label>播放频率<select data-startup="mode"><option value="always">每次启动</option><option value="daily">每天第一次</option><option value="off">关闭</option></select></label>
          <label>主题<select data-startup="theme"><option value="follow">跟随工作台</option><option value="day">晨光</option><option value="night">夜金</option></select></label>
          <label>动画速度 <output data-startup-output="speed"></output><input type="range" min="0.35" max="3" step="0.05" data-startup="speed"></label>
          <label>双龙入场秒数 <output data-startup-output="flyIn"></output><input type="range" min="4" max="14" step="0.5" data-startup="flyIn"></label>
          <label><input type="checkbox" data-startup="requireConfirm">等待点击确认</label>
          <label><input type="checkbox" data-startup="allowSkip">允许跳过开屏</label>
        </fieldset>
        <fieldset><legend>液态玻璃</legend>
          <label><input type="checkbox" data-startup="glass">启用玻璃效果</label>
          <label>底板不透明度 <output data-startup-output="glassOpacity"></output><input type="range" min="0.15" max="0.95" step="0.01" data-startup="glassOpacity"></label>
          <label>底板模糊 px <output data-startup-output="glassBlur"></output><input type="range" min="0" max="60" step="1" data-startup="glassBlur"></label>
          <label>饱和度 % <output data-startup-output="glassSaturate"></output><input type="range" min="100" max="200" step="1" data-startup="glassSaturate"></label>
          <label>背景模糊 px <output data-startup-output="backdropBlur"></output><input type="range" min="0" max="80" step="1" data-startup="backdropBlur"></label>
        </fieldset>
        <fieldset><legend>身份</legend>
          <label>欢迎名称<input type="text" maxlength="24" data-identity="identity"></label>
          <label>身份编号<input type="text" maxlength="80" data-identity="identityId"></label>
          <label>身份等级<input type="text" maxlength="80" data-identity="accessLevel"></label>
          <button type="button" data-identity-save>保存身份</button><span role="status" data-identity-status></span>
        </fieldset>
        <fieldset><legend>语音</legend>
          <label><input type="checkbox" data-startup="voice">启用语音</label>
          <label>音量 <output data-startup-output="voiceVolume"></output><input type="range" min="0" max="1" step="0.05" data-startup="voiceVolume"></label>
          <label><input type="checkbox" data-startup="voiceCue">每句播放提示音</label>
        </fieldset>
        <fieldset><legend>音效</legend>
          <label><input type="checkbox" data-startup="sfx">启用音效</label>
          <label>音效音量 <output data-startup-output="sfxVolume"></output><input type="range" min="0" max="1" step="0.05" data-startup="sfxVolume"></label>
        </fieldset>
      </div>
      <p class="wb-settings__startup-status" role="status" data-startup-status></p>
    </section>
    <section class="wb-settings__workspace" aria-label="Markdown 模板管理">
      <aside class="wb-settings__list-panel">
        <div class="wb-settings__section-heading"><h2>Markdown 模板</h2><button type="button" data-template-new aria-label="新建模板">＋</button></div>
        <div class="wb-settings__template-list" data-template-list></div>
      </aside>
      <form class="wb-settings__editor" data-template-form>
        <div class="wb-settings__section-heading"><h2 data-template-editor-heading>新建模板</h2><span role="status" data-template-status></span></div>
        <label>标题<input data-template-title maxlength="240" required placeholder="例如：文献阅读记录"></label>
        <label class="wb-settings__body-label">模板正文<textarea data-template-body maxlength="30000" placeholder="用 Markdown 编写模板内容"></textarea></label>
        <footer><button type="button" data-template-cancel>取消编辑</button><button type="submit" class="wb-settings__primary" data-template-save>保存模板</button></footer>
      </form>
    </section>`;

  const list = panel.querySelector('[data-template-list]');
  const form = panel.querySelector('[data-template-form]');
  const title = panel.querySelector('[data-template-title]');
  const body = panel.querySelector('[data-template-body]');
  const status = panel.querySelector('[data-template-status]');
  const heading = panel.querySelector('[data-template-editor-heading]');
  const startupStatus = panel.querySelector('[data-startup-status]');
  const identityStatus = panel.querySelector('[data-identity-status]');
  const identityInputs = [...panel.querySelectorAll('[data-identity]')];
  let startupConfig = getStartupConfig();
  let startupIdentity = { identity: '反穿衣', identityId: 'RW-0001', accessLevel: '研究员 · 3' };
  let templates = [];
  let selected = null;
  let dirty = false;
  let saving = false;

  function formatRangeValue(key, value) {
    return ['speed', 'flyIn', 'glassOpacity', 'voiceVolume', 'sfxVolume'].includes(key)
      ? Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
      : String(value);
  }

  function renderStartupConfig() {
    for (const input of panel.querySelectorAll('[data-startup]')) {
      const key = input.dataset.startup;
      input.value = String(startupConfig[key]);
      if (input.type === 'checkbox') input.checked = startupConfig[key];
      const output = panel.querySelector(`[data-startup-output="${key}"]`);
      if (output) output.value = formatRangeValue(key, startupConfig[key]);
    }
  }

  async function saveIdentity() {
    const next = Object.fromEntries(identityInputs.map(input => [input.dataset.identity, input.value.trim()]));
    next.identity ||= '反穿衣';
    if (Object.entries(next).some(([key, value]) => [...value].length > (key === 'identity' ? 24 : 80))) {
      identityStatus.textContent = '身份字段超出长度限制。';
      return false;
    }
    try {
      await api.saveState({ startupIdentity: next });
      startupIdentity = (await api.loadState()).startupIdentity;
      for (const input of identityInputs) input.value = startupIdentity[input.dataset.identity];
      identityStatus.textContent = '已保存';
      showNotice('开屏身份已保存。');
      return true;
    } catch (error) {
      identityStatus.textContent = errorText(error);
      showNotice(errorText(error), true);
      return false;
    }
  }

  function renderList() {
    list.replaceChildren();
    if (!templates.length) {
      list.append(element('p', 'wb-settings__empty', '还没有模板，点击 ＋ 新建。'));
      return;
    }
    for (const template of templates) {
      const button = element('button', 'wb-settings__template-item', template.title || '未命名模板');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(template.id === selected?.id));
      button.onclick = () => {
        if (!confirmDiscard()) return;
        openTemplate(template);
      };
      list.append(button);
    }
  }

  function markDirty() {
    dirty = true;
    status.textContent = '有未保存修改';
  }

  function confirmDiscard() {
    return !dirty || confirm('当前模板尚未保存，切换后会丢弃修改。继续吗？');
  }

  function openTemplate(template) {
    selected = template;
    title.value = template?.title ?? '';
    body.value = template?.fields?.templateBody ?? template?.body ?? '';
    heading.textContent = template ? '编辑模板' : '新建模板';
    status.textContent = '';
    dirty = false;
    renderList();
  }

  async function load() {
    try {
      templates = await templateApi.list({ kind: 'template' });
      renderList();
      if (selected && !dirty) {
        const latest = templates.find(item => item.id === selected.id);
        if (latest) openTemplate(latest);
      }
    } catch (error) {
      status.textContent = errorText(error);
      showNotice(errorText(error), true);
    }
  }

  panel.querySelector('[data-template-new]').onclick = () => {
    if (!confirmDiscard()) return;
    openTemplate(null);
    title.focus();
  };
  panel.querySelector('[data-template-cancel]').onclick = () => {
    if (!confirmDiscard()) return;
    openTemplate(selected);
  };
  for (const input of panel.querySelectorAll('[data-startup]')) {
    const eventName = input.type === 'range' ? 'input' : 'change';
    input.addEventListener(eventName, () => {
      const key = input.dataset.startup;
      try {
        startupConfig = saveStartupConfig({ [key]: input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value });
      } catch {
        renderStartupConfig();
        startupStatus.textContent = '无法保存开屏设置。';
        return;
      }
      const output = panel.querySelector(`[data-startup-output="${key}"]`);
      if (output) output.value = formatRangeValue(key, startupConfig[key]);
      startupStatus.textContent = '已保存';
      if (key === 'voiceVolume' || key === 'voiceCue') window.dispatchEvent(new CustomEvent('stilltime-startup-audio-settings-change', { detail: startupConfig }));
    });
  }
  for (const input of identityInputs) input.addEventListener('input', () => { identityStatus.textContent = '有未保存修改'; });
  panel.querySelector('[data-identity-save]').onclick = () => void saveIdentity();
  panel.querySelector('[data-startup-preview]').onclick = async () => {
    if (identityStatus.textContent === '有未保存修改' && !(await saveIdentity())) return;
    try { await onPreview({ ...startupConfig, identity: { ...startupIdentity } }); }
    catch (error) { showNotice(errorText(error), true); }
  };
  panel.querySelector('[data-startup-test-voice]').onclick = async () => {
    if (identityStatus.textContent === '有未保存修改' && !(await saveIdentity())) return;
    try { await onTestVoice({ ...startupConfig, identity: { ...startupIdentity } }); }
    catch (error) { showNotice(errorText(error), true); }
  };
  renderStartupConfig();
  void api.loadState().then(state => {
    startupIdentity = state.startupIdentity ?? startupIdentity;
    if (identityStatus.textContent !== '有未保存修改') {
      for (const input of identityInputs) input.value = startupIdentity[input.dataset.identity];
    }
  }).catch(error => { identityStatus.textContent = errorText(error); });
  form.addEventListener('input', markDirty);
  async function saveTemplate() {
    if (saving || !form.reportValidity()) return false;
    saving = true;
    panel.querySelector('[data-template-save]').disabled = true;
    try {
      const saved = await templateApi.saveTemplate({
        id: selected?.id,
        title: title.value,
        area: selected?.area ?? '',
        body: body.value,
        expectedUpdatedAt: selected?.updatedAt ?? null,
      });
      selected = saved;
      dirty = false;
      await load();
      status.textContent = '已保存';
      showNotice('Markdown 模板已保存。');
      return true;
    } catch (error) {
      status.textContent = errorText(error);
      showNotice(errorText(error), true);
      return false;
    } finally {
      saving = false;
      panel.querySelector('[data-template-save]').disabled = false;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void saveTemplate();
  });

  void load();
  return {
    load,
    isDirty: () => dirty,
    requestSave: saveTemplate,
    pendingEntries() {
      return dirty ? [{
        key: 'markdown-template',
        title: title.value || '未命名模板',
        focus: () => title.focus(),
        save: () => saveTemplate(),
      }] : [];
    },
  };
}
