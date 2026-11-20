const api = window.stilltimeDesktop?.risk;
const names = { settings: '数据与备份', mirror: 'AI 审核', snapshots: '文章快照' };
const labels = {
  synced: '已同步', 'pending-review': '待审核', conflict: '双方有改动',
  'mirror-deleted': '镜像中已删除', 'blocked-private': '私密', 'blocked-ignore': '已排除',
  'source-missing': '真实稿不存在', 'identity-conflict': '文件 ID 已改变', invalid: '需要修正',
  new: '新稿', busy: 'Harness 写入中',
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function mount() {
  const css = el('link');
  css.rel = 'stylesheet';
  css.href = '/risk-tools.css';
  document.head.append(css);
  const dialog = el('dialog', null, 'wb-risk-dialog');
  const header = el('header');
  const title = el('h2');
  title.id = 'wb-risk-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const body = el('section', null, 'wb-risk-body');
  const status = el('p', null, 'wb-risk-status');
  status.setAttribute('role', 'status');
  const close = el('button', '关闭', 'wb-button');
  close.type = 'button';
  close.onclick = () => dialog.close();
  header.append(title, close);
  dialog.append(header, body, status);
  document.getElementById('workbench').append(dialog);
  let page = '';
  let selectedLink;
  let generation = 0;
  let busy = false;
  let externalBackupError = '';

  const formatError = error => error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(error);
  function action(text, operation, primary = false) {
    const button = el('button', text, 'wb-button' + (primary ? ' wb-primary' : ''));
    button.type = 'button';
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      status.textContent = '';
      try { await operation(); }
      catch (error) { status.textContent = formatError(error); }
      finally { busy = false; button.disabled = false; }
    });
    return button;
  }
  const actions = (...buttons) => {
    const row = el('div', null, 'wb-risk-actions');
    row.append(...buttons);
    return row;
  };
  function field(label, input) {
    const box = el('label', label, 'wb-risk-field');
    box.append(input);
    return box;
  }
  function details(label, value) {
    const item = el('details');
    item.append(el('summary', label), el('pre', value == null ? '无' : typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'wb-risk-code'));
    return item;
  }
  function line(title, subtitle) {
    const item = el('article', null, 'wb-risk-item');
    item.append(el('strong', title), el('small', subtitle));
    return item;
  }
  const timeString = value => value ? new Date(value).toLocaleString('zh-CN') : '';
  function diff(before, after) {
    const oldLines = before.split(/\r?\n/);
    const newLines = after.split(/\r?\n/);
    let start = 0;
    let end = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    while (end < oldLines.length - start && end < newLines.length - start &&
      oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]) end++;
    const removed = oldLines.slice(start, oldLines.length - end);
    const added = newLines.slice(start, newLines.length - end);
    return [`第 ${start + 1} 行附近`, ...removed.map(line => '− ' + line), ...added.map(line => '+ ' + line)].join('\n');
  }

  async function renderSettings(section) {
    const [prefs, local, snapshots] = await Promise.all([api.preferences(), api.dataRoot(), api.snapshots()]);
    const day = el('input');
    day.type = 'time';
    day.value = [Math.floor(prefs.dayStartMinutes / 60), prefs.dayStartMinutes % 60].map(x => String(x).padStart(2, '0')).join(':');
    const low = el('input');
    low.type = 'checkbox';
    low.checked = prefs.lowPower;
    const ouro = el('input');
    ouro.type = 'checkbox';
    ouro.checked = prefs.showOuroboros;
    const warn = el('input');
    warn.type = 'checkbox';
    warn.checked = prefs.warnActionLimit;
    const save = action('保存偏好设置', async () => {
      if (!day.value) throw new Error('请选择每天开始的时间。');
      const [hour, minute] = day.value.split(':').map(Number);
      const updated = await api.savePreferences({ dayStartMinutes: hour * 60 + minute, lowPower: low.checked, showOuroboros: ouro.checked, warnActionLimit: warn.checked });
      window.dispatchEvent(new CustomEvent('stilltime-risk-preferences', { detail: updated }));
      status.textContent = '设置已保存。';
    }, true);
    section.append(
      line(local.portable ? '数据目录（便携启动）' : '数据目录', local.root),
      ...(local.portable || local.source === 'override' ? [el('p', '将程序目录中的 Documents/Notes 随工作台一起复制到新环境，即可读取其中的笔记。选择程序目录可恢复自动识别。')] : []),
      ...(local.warning ? [el('p', local.warning)] : []),
      actions(action('选择现有目录', () => api.pickDataRoot())),
      field('每日开始时间', day), field('失焦时暂停动态画面', low), field('显示衔尾蛇背景', ouro), field('行动中的想法超过 3 个时提醒', warn), actions(save),
      line('额外备份位置', prefs.backupDirectory || '使用独立硬盘或 USB 可覆盖整盘故障。'),
      el('p', '应用运行时生成每日 ZIP，范围包括受管理的 Markdown 和设置。额外备份会按数据目录分开放置。'),
      ...(externalBackupError ? [el('p', '上次自动备份：' + externalBackupError)] : []),
      actions(
        action('选择额外位置', async () => { await api.pickBackup(); await openPage('settings'); }),
        ...(prefs.backupDirectory ? [action('移除额外位置', async () => { await api.clearBackup(); await openPage('settings'); })] : []),
        action('立即备份', async () => { await api.snapshot(); await openPage('settings'); status.textContent = '已生成并校验备份。'; }),
        action('恢复 ZIP 到空目录', async () => {
          const result = await api.restoreSnapshot();
          if (result) status.textContent = '恢复完成。请在目标目录中查看恢复后的文件。';
        }),
      ),
      actions(action('检查并升级 Markdown', async () => {
        if (!window.confirm('工作台将先备份 Markdown 和设置，再给受管理的记录补齐 ID 与格式版本。现在开始？')) return;
        const result = await api.migrate();
        status.textContent = '升级结果已列在下方。';
        section.append(details('迁移结果', result));
      })),
    );
    if (snapshots?.length) section.append(details('本地备份', snapshots.map(item => typeof item === 'string' ? item : item.name || item.file || item.path).join('\n')));
  }

  async function renderSnapshot(section, id, selected) {
    const text = el('textarea');
    text.placeholder = '粘贴要保留的文章正文或摘录';
    const entries = el('div');
    const preview = el('pre', null, 'wb-risk-code');
    preview.hidden = true;
    section.append(field('本地快照正文', text), actions(action('保存新快照', async () => {
      await api.saveLinkSnapshot(id, text.value);
      await openPage('snapshots', id);
      status.textContent = '快照已保存。';
    }, true)), entries, preview);
    const versions = await api.listLinkSnapshots(id);
    if (!versions.length) entries.append(el('p', '还没有快照。'));
    async function display(version, anchor) {
      preview.textContent = await api.readLinkSnapshot(id, version.id);
      preview.hidden = false;
      const offset = anchor ? preview.textContent.indexOf(anchor) : -1;
      if (offset >= 0) {
        const mark = el('mark', anchor);
        const text = preview.textContent;
        preview.replaceChildren(text.slice(0, offset), mark, text.slice(offset + anchor.length));
        mark.scrollIntoView({ block: 'nearest' });
      }
    }
    for (const version of versions) entries.append(actions(action(timeString(version.date), () => display(version))));
    if (selected?.snapshotId) {
      const version = versions.find(item => item.id === selected.snapshotId);
      if (!version) throw new Error('找不到这份文章快照。');
      await display(version, selected.anchor);
    }
  }

  async function renderMirror(section) {
    const snapshot = await api.mirror();
    const mirrorStatus = await api.mirrorStatus();
    const records = await api.records();
    section.append(el('p', '只将你选中的 Markdown 交给 Harness。请在工作台审核后写回。'),
      actions(action('打开 AI 镜像目录', () => api.revealMirror()), action('查看拒绝留档', () => api.revealRejected()),
        action('刷新审核', () => openPage('mirror'))));
    if (mirrorStatus.busy) section.append(el('p', 'Harness 正在写入，审核已暂停。'));
    const entries = [...(snapshot.entries ?? []), ...(snapshot.drafts ?? []).map(item => ({ ...item, status: 'new' }))];
    for (const entry of entries.filter(item => item.status !== 'synced' && item.status !== 'busy')) {
      const item = line(entry.title || entry.path || entry.relativePath || entry.id, labels[entry.status] || entry.status);
      const proposal = entry.mirror ?? entry.content ?? entry.body;
      if (typeof entry.source === 'string' && typeof proposal === 'string') {
        item.append(details('真实稿到镜像稿的变化', diff(entry.source, proposal)));
      }
      item.append(details('基准稿', entry.base), details('真实稿', entry.source), details('镜像草稿', proposal));
      const removed = entry.status === 'mirror-deleted';
      const review = action(removed ? '恢复镜像文件' : entry.status === 'conflict' ? '接受镜像中的 AI 区块' : '接受',
        () => submitReview(entry, removed ? 'restore-deleted' : 'accept'), true);
      const refuse = action('拒绝并留档', () => submitReview(entry, entry.status === 'new' ? 'reject-draft' : 'reject'));
      review.disabled = mirrorStatus.busy || !['new', 'conflict', 'pending-review', 'mirror-deleted'].includes(entry.status);
      refuse.disabled = mirrorStatus.busy || !['new', 'conflict', 'pending-review'].includes(entry.status);
      item.append(actions(review, refuse));
      section.append(item);
    }
    if (entries.every(item => item.status === 'synced')) section.append(el('p', '当前没有待审核稿。'));
    const picker = el('details');
    const find = el('input');
    find.type = 'search';
    find.placeholder = '搜索标题或路径';
    const items = el('div');
    const selectedIds = new Set(entries.filter(entry => !['new', 'blocked-private', 'blocked-ignore'].includes(entry.status)).map(entry => entry.id));
    function showRecords() {
      const query = find.value.toLowerCase().trim();
      const matches = records.filter(record => record.id && !/^(?:Files|LinksSnapshots|InspirationBoard|WeeklyReviews|MoodJournal|LifeExperiences|ContentBoard|Templates|CustomAreas|Vocabulary|Terminology)[\\/]/i.test(record.relativePath)
        && [record.title, record.relativePath].join(' ').toLowerCase().includes(query));
      items.replaceChildren();
      for (const record of matches.slice(0, 45)) {
        const item = line(record.title || record.relativePath, record.relativePath);
        const exportFile = action(selectedIds.has(record.id) ? '已加入镜像' : '加入 AI 镜像', async () => {
          await api.share(record.id, record.relativePath);
          await openPage('mirror');
          status.textContent = '文件已加入镜像。';
        });
        exportFile.disabled = record.private || mirrorStatus.busy || selectedIds.has(record.id);
        const switchPrivacy = action(record.private ? '允许手动分享' : '设为私密', async () => {
          await api.setPrivate(record.id, !record.private, record.relativePath);
          await openPage('mirror');
          status.textContent = '私密设置已更新。';
        });
        const loadHistory = action('查看版本', async () => {
          const versions = await api.recordHistory(record.relativePath);
          if (!versions.length) { status.textContent = '这份记录暂无历史版本。'; return; }
          const list = el('div');
          for (const version of versions) list.append(actions(el('span', timeString(version.createdAt) + ' · ' + version.title),
            action('恢复该版本', async () => {
              if (!window.confirm('恢复这份记录到所选版本？当前内容将先保存到历史。')) return;
              await api.restoreRecord(record.relativePath, version.revision);
              await openPage('mirror');
              status.textContent = '记录已恢复。';
            })));
          item.append(list);
          loadHistory.remove();
        });
        switchPrivacy.disabled = mirrorStatus.busy || record.inheritedPrivacy;
        item.append(actions(exportFile, switchPrivacy, loadHistory));
        items.append(item);
      }
      if (matches.length > 45) items.append(el('p', '显示前 45 项。可按标题或路径缩小范围。'));
    }
    find.oninput = showRecords;
    picker.append(el('summary', '加入记录或设置私密'), field('过滤记录', find), items);
    showRecords();
    section.append(picker);
  }

  async function submitReview(entry, operation) {
    const result = await api.review({
      id: entry.id || undefined, action: operation, relativePath: entry.relativePath ?? entry.path,
      expectedSourceHash: entry.sourceHash, expectedMirrorHash: entry.mirrorHash ?? entry.hash,
    });
    await openPage('mirror');
    status.textContent = result?.message ?? ({
      accept: '审核已接受。', reject: '草稿已留档。', 'reject-draft': '草稿已留档。', 'restore-deleted': '已恢复镜像文件。',
    })[operation];
  }

  async function openPage(next, id = selectedLink, selected) {
    const request = ++generation;
    page = next;
    selectedLink = id;
    title.textContent = names[next];
    status.textContent = '';
    const section = el('div', null, 'wb-risk-body');
    section.style.padding = '0';
    body.replaceChildren(section);
    if (!dialog.open) dialog.showModal();
    try {
      if (next === 'settings') await renderSettings(section);
      if (next === 'snapshots') await renderSnapshot(section, id, selected);
      if (next === 'mirror') await renderMirror(section);
    } catch (error) {
      if (request === generation) status.textContent = formatError(error);
    }
  }
  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-risk-open],[data-risk-snapshot]');
    if (opener?.dataset.riskSnapshot) void openPage('snapshots', opener.dataset.riskSnapshot);
    else if (names[opener?.dataset.riskOpen]) void openPage(opener.dataset.riskOpen);
  });
  window.addEventListener('stilltime-open-snapshot', ({ detail }) => {
    void openPage('snapshots', detail.id, detail);
  });
  api.onBackupError(message => { externalBackupError = message; });
  window.addEventListener('stilltime-startup-mirror', ({ detail: count }) => {
    const review = el('button', 'AI 审核 · ' + count, 'wb-appearance-trigger wb-risk-launch');
    review.type = 'button';
    review.dataset.riskOpen = 'mirror';
    review.title = '查看待审核的镜像改动';
    document.querySelector('.wb-top [data-risk-open="settings"]')?.before(review);
    review.addEventListener('click', () => review.remove(), { once: true });
  });
  api.onMirrorChanged(value => {
    if (dialog.open && page === 'mirror' && !busy) {
      status.textContent = value.error || (value.busy ? 'Harness 正在写入。' : '镜像有变化，可刷新审核列表。');
    }
  });
}

if (api) mount();
