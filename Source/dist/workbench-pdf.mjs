import { GlobalWorkerOptions, getDocument, TextLayer } from './vendor/pdfjs/pdf.mjs';
import { renderWorkbenchIcons } from './icons.mjs';
import { cleanPdfSelection, cleanSelectedText } from './translation.mjs';

GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const PDFJS_ASSET_BASE = new URL('./vendor/pdfjs/', import.meta.url).href;
const MAX_PAGE_PIXELS = 16_000_000;
const MAX_CACHED_PAGES = 2;
const ZOOM_SETTLE_MS = 120;

export function createWorkbenchPdf(container, { onPageChange = () => {}, onCreateIdea = null, onTranslateSelection = null } = {}) {
  let loadingTask = null;
  let pdfDocument = null;
  let pageNumber = 1;
  let openToken = 0;
  let pages = [];
  let fallbackSize;
  const mounted = new Set();
  let activeDraw = null;
  let pendingNavigation = null;
  let lastScrollTop = 0;
  let direction = 1;
  let useOrder = 0;
  let scrollFrame = 0;
  let navigationAnchor = null;
  let pageInputSubmitted = false;
  let disposed = false;
  let resizeFrame = 0;
  let zoomFrame = 0;
  let zoomTimer = 0;
  let zoomSteps = 0;
  let zoomAnchor = null;

  container.classList.add('workbench-pdf');
  container.innerHTML = `
    <div class="workbench-pdf__toolbar" role="toolbar" aria-label="PDF 阅读控制">
      <button class="workbench-pdf__previous" type="button" aria-label="上一页"><span data-wb-icon="chevronLeft"></span></button>
      <label class="workbench-pdf__page-label"><input class="workbench-pdf__page-input" type="number" min="1" value="1" aria-label="页码"><span class="workbench-pdf__page-count">/ —</span></label>
      <button class="workbench-pdf__next" type="button" aria-label="下一页"><span data-wb-icon="chevronRight"></span></button>
      <span class="workbench-pdf__spacer"></span>
      <button class="workbench-pdf__zoom-out" type="button" aria-label="缩小"><span data-wb-icon="minus"></span></button>
      <span class="workbench-pdf__zoom-value">适合宽度</span>
      <button class="workbench-pdf__zoom-in" type="button" aria-label="放大"><span data-wb-icon="plus"></span></button>
      ${onCreateIdea ? '<button class="workbench-pdf__capture" data-pdf-capture type="button" aria-label="将选中文字保存为灵感卡片" disabled><span data-wb-icon="note"></span><span>摘录灵感</span></button>' : ''}
      ${onTranslateSelection ? '<button class="workbench-pdf__translate" data-pdf-translate type="button" aria-label="翻译选中文字" disabled><span data-wb-icon="note"></span><span>翻译</span></button>' : ''}
      <span class="workbench-pdf__status" role="status"></span>
    </div>
    <div class="workbench-pdf__viewport" tabindex="0" aria-label="PDF 页面">
      <div class="workbench-pdf__pages"></div>
    </div>`;
  renderWorkbenchIcons(container);

  const viewport = container.querySelector('.workbench-pdf__viewport');
  const pageList = container.querySelector('.workbench-pdf__pages');
  const pageInput = container.querySelector('.workbench-pdf__page-input');
  const pageCount = container.querySelector('.workbench-pdf__page-count');
  const status = container.querySelector('.workbench-pdf__status');
  const zoomLabel = container.querySelector('.workbench-pdf__zoom-value');
  const captureButton = container.querySelector('.workbench-pdf__capture');
  const translateButton = container.querySelector('.workbench-pdf__translate');
  const previousButton = container.querySelector('.workbench-pdf__previous');
  const nextButton = container.querySelector('.workbench-pdf__next');
  pageInput.disabled = true;
  previousButton.disabled = true;
  nextButton.disabled = true;
  container.querySelector('.workbench-pdf__zoom-in').disabled = true;
  container.querySelector('.workbench-pdf__zoom-out').disabled = true;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  let zoom = 0;
  let fitWidth = 0;
  const pageLines = new Map();

  function selectionPages() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    function pageOf(node) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const layer = element?.closest('.workbench-pdf__text-layer');
      return layer && viewport.contains(layer)
        ? pages[Number(layer.parentElement.dataset.pageNumber) - 1] : null;
    }
    const first = pageOf(range.startContainer);
    const last = pageOf(range.endContainer);
    return first && last ? { selection, range, first, last } : null;
  }

  function selectedQuote() {
    return selectionPages()?.selection.toString().trim() || '';
  }

  function selectedSentence(info) {
    const { range, selection } = info;
    const textLayer = info.first.slot.querySelector('.workbench-pdf__text-layer');
    if (info.first !== info.last || !textLayer) return cleanSelectedText(selection.toString());
    const selectedLines = new Set();
    const lines = new Map();
    for (const span of textLayer.children) {
      const text = span.textContent?.trim();
      if (!text) continue;
      let intersects = false;
      try { intersects = range.intersectsNode(span); } catch { /* Detached text can be ignored. */ }
      const bounds = span.getBoundingClientRect();
      const key = Math.round(bounds.top / 3) * 3;
      if (intersects) selectedLines.add(key);
      const entries = lines.get(key) ?? [];
      entries.push({ x: bounds.left, text });
      lines.set(key, entries);
    }
    const orderedKeys = [...lines.keys()].sort((a, b) => a - b);
    const contextLines = orderedKeys.map(key => (lines.get(key) ?? []).sort((a, b) => a.x - b.x).map(entry => entry.text).join(' '));
    const selectedIndices = orderedKeys.map((key, index) => selectedLines.has(key) ? index : -1).filter(index => index >= 0);
    if (!selectedIndices.length) return cleanSelectedText(selection.toString());
    let first = selectedIndices[0];
    let last = selectedIndices.at(-1);
    const endsSentence = line => /[.!?。！？][\s”’\])}]*$/.test(line.trim());
    let steps = 0;
    while (first > 0 && steps < 2 && !endsSentence(contextLines[first - 1])) { first--; steps++; }
    steps = 0;
    while (last < contextLines.length - 1 && steps < 2 && !endsSentence(contextLines[last])) { last++; steps++; }
    const context = contextLines.slice(first, last + 1).join(' ');
    return cleanSelectedText(context || selection.toString());
  }

  async function linesForPage(number, document) {
    if (pageLines.has(number)) return pageLines.get(number);
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = [];
    for (const item of content.items) {
      if (!item.str?.trim() || !item.transform) continue;
      const top = viewport.height - item.transform[5];
      const key = Math.round(top / 3) * 3;
      let line = lines.find(entry => Math.abs(entry.key - key) <= 3);
      if (!line) { line = { key, top, items: [] }; lines.push(line); }
      line.items.push({ x: item.transform[4], text: item.str });
    }
    const result = lines.map(line => ({
      top: line.top / viewport.height,
      text: line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim(),
    })).filter(line => line.text);
    if (document === pdfDocument) pageLines.set(number, result);
    return result;
  }

  async function repeatedMarginLines(number, document) {
    if (document.numPages < 2) return [];
    const adjacent = [number - 1, number + 1].filter(page => page >= 1 && page <= document.numPages);
    const [current, ...neighbors] = await Promise.all([number, ...adjacent].map(page => linesForPage(page, document)));
    const repeated = new Set();
    const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    for (const line of current) {
      if (line.text.length < 3 || (line.top > 0.08 && line.top < 0.92)) continue;
      const key = normalize(line.text);
      if (neighbors.some(lines => lines.some(candidate => {
        const sameMargin = (line.top <= 0.08 && candidate.top <= 0.08) || (line.top >= 0.92 && candidate.top >= 0.92);
        return sameMargin && normalize(candidate.text) === key;
      }))) repeated.add(line.text);
    }
    return [...repeated];
  }

  function updateCaptureButton() {
    if (captureButton) captureButton.disabled = !pdfDocument || !selectedQuote();
    if (translateButton) translateButton.disabled = !pdfDocument || !selectedQuote();
  }

  function onSelectionChange() {
    updateCaptureButton();
  }

  function contentWidth() {
    const style = getComputedStyle(viewport);
    const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return Math.max(1, viewport.clientWidth - inset);
  }

  function sizePage(item, available = contentWidth()) {
    const size = item.size || fallbackSize;
    const scale = zoom || available / size.width;
    item.scale = scale;
    item.slot.style.width = `${size.width * scale}px`;
    item.slot.style.height = `${size.height * scale}px`;
  }

  function release(item) {
    const previous = item.render;
    mounted.delete(item);
    item.render = null;
    item.slot.replaceChildren();
    if (previous) previous.canvas.width = previous.canvas.height = 0;
  }

  function cancelDraw() {
    if (!activeDraw || activeDraw.canceled) return;
    activeDraw.canceled = true;
    activeDraw.canvasTask?.cancel();
    activeDraw.textTask?.cancel();
  }

  function settleNavigation(result) {
    const waiting = pendingNavigation;
    pendingNavigation = null;
    waiting?.resolve(result);
  }

  function updateActualSize(item, size) {
    const wasAbove = item.slot.offsetTop + item.slot.offsetHeight <= viewport.scrollTop;
    const beforeHeight = item.slot.offsetHeight;
    item.size = size;
    sizePage(item);
    if (wasAbove) {
      viewport.scrollTop += item.slot.offsetHeight - beforeHeight;
      lastScrollTop = viewport.scrollTop;
      if (navigationAnchor) navigationAnchor.top = lastScrollTop;
    }
  }

  async function drawPage(job) {
    const { item, document: source } = job;
    const valid = () => !job.canceled && pdfDocument === source && !disposed;
    let canvas;
    let committed = false;
    try {
      const page = await source.getPage(item.number);
      if (!valid()) return false;
      if (!item.size) updateActualSize(item, page.getViewport({ scale: 1 }));
      job.scale = item.scale;
      const renderViewport = page.getViewport({ scale: job.scale });
      const ratio = Math.min(pixelRatio, Math.sqrt(MAX_PAGE_PIXELS / (renderViewport.width * renderViewport.height)));
      canvas = document.createElement('canvas');
      canvas.className = 'workbench-pdf__canvas';
      canvas.width = Math.max(1, Math.floor(renderViewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(renderViewport.height * ratio));
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const layer = document.createElement('div');
      layer.className = 'workbench-pdf__text-layer';
      job.canvasTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: renderViewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      job.textTask = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: renderViewport });
      await Promise.all([job.canvasTask.promise, job.textTask.render()]);
      if (!valid() || job.scale !== item.scale) return false;

      const previous = item.render;
      item.slot.replaceChildren(canvas, layer);
      item.render = { canvas, layer, scale: job.scale };
      item.failedScale = undefined;
      mounted.add(item);
      committed = true;
      if (previous) previous.canvas.width = previous.canvas.height = 0;
      if (status.textContent === `第 ${item.number} 页渲染失败`) status.textContent = '';
      return true;
    } catch (error) {
      if (valid() && error?.name !== 'RenderingCancelledException') {
        item.failedScale = item.scale;
        if (pageNumber === item.number) status.textContent = `第 ${item.number} 页渲染失败`;
      }
      return false;
    } finally {
      if (!committed) {
        job.canvasTask?.cancel();
        job.textTask?.cancel();
        if (canvas) canvas.width = canvas.height = 0;
      }
    }
  }

  function needsDraw(item) {
    return item.render?.scale !== item.scale && item.failedScale !== item.scale;
  }

  function drawNext(wanted, visible) {
    const next = wanted.find(needsDraw);
    if (activeDraw) {
      const { item, scale } = activeDraw;
      const obsolete = !wanted.includes(item) || (scale !== undefined && scale !== item.scale);
      const visibleFirst = next && visible.has(next) && !visible.has(item);
      const explicitJump = pendingNavigation && pendingNavigation.item !== item;
      if (obsolete || visibleFirst || explicitJump) cancelDraw();
      return;
    }
    if (!next) return;
    const job = { item: next, document: pdfDocument, canceled: false };
    activeDraw = job;
    void drawPage(job).then(painted => {
      activeDraw = null;
      if (!job.canceled && pendingNavigation?.item === next) settleNavigation(painted);
      refreshVisible();
    });
  }

  function trimCache(wanted) {
    const selection = selectionPages();
    const selected = item => selection && item.number >= selection.first.number && item.number <= selection.last.number;
    const cached = [...mounted].filter(item => !wanted.includes(item) && !selected(item))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    let pixels = 0;
    let retained = 0;
    for (const item of cached) {
      const { canvas } = item.render;
      const size = canvas.width * canvas.height;
      if (retained < MAX_CACHED_PAGES && pixels + size <= MAX_PAGE_PIXELS) {
        retained++;
        pixels += size;
      } else release(item);
    }
  }

  function pageAt(position) {
    let low = 0;
    let high = pages.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const { slot } = pages[middle];
      if (slot.offsetTop + slot.offsetHeight <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function updatePage(number) {
    const changed = pageNumber !== number;
    pageNumber = number;
    if (document.activeElement !== pageInput || changed) pageInput.value = String(number);
    previousButton.disabled = number <= 1;
    nextButton.disabled = number >= pages.length;
    if (changed) onPageChange(number, pages.length);
  }

  function refreshVisible() {
    if (!pages.length || disposed) return;
    if (!viewport.clientHeight || !viewport.clientWidth) {
      resetZoomInput();
      cancelDraw();
      settleNavigation(false);
      for (const item of mounted) release(item);
      return;
    }
    if (zoomAnchor) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    if (scrollTop !== lastScrollTop) direction = scrollTop > lastScrollTop ? 1 : -1;
    lastScrollTop = scrollTop;
    const first = pageAt(scrollTop);
    const last = pageAt(scrollTop + clientHeight);
    const atEnd = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2;
    const focus = atEnd ? last : Math.min(last, pageAt(scrollTop + Math.min(clientHeight * .2, 90)));
    if (navigationAnchor && Math.abs(scrollTop - navigationAnchor.top) > 1) {
      navigationAnchor = null;
      settleNavigation(false);
    }
    const priority = pages[(navigationAnchor?.number ?? (focus + 1)) - 1];
    updatePage(priority.number);
    const visible = new Set([priority, ...pages.slice(first, last + 1)]);
    for (const item of visible) item.lastSeen = ++useOrder;
    const wanted = [...visible];
    const ahead = pages[direction > 0 ? last + 1 : first - 1];
    if (ahead && !visible.has(ahead)) {
      if (!ahead.lastSeen) ahead.lastSeen = ++useOrder;
      wanted.push(ahead);
    }
    trimCache(wanted);
    drawNext(wanted, visible);
  }

  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      refreshVisible();
    });
  }
  viewport.addEventListener('scroll', onScroll, { passive: true });

  async function goToPage(page) {
    if (!pages.length || !viewport.clientHeight) return false;
    if (zoomAnchor) finishZoom(false);
    settleNavigation(false);
    const item = pages[Math.max(1, Math.min(pages.length, Math.floor(page) || 1)) - 1];
    viewport.scrollTop = item.slot.offsetTop - Math.min(12, item.slot.offsetTop);
    navigationAnchor = { number: item.number, top: viewport.scrollTop };
    item.failedScale = undefined;
    if (!needsDraw(item)) {
      refreshVisible();
      return true;
    }
    const painted = new Promise(resolve => { pendingNavigation = { item, resolve }; });
    refreshVisible();
    return painted;
  }

  async function goToQuote(page, quote) {
    if (!quote || !Number.isInteger(page) || page < 1 || page > pages.length) return false;
    return await goToPage(page) && highlightQuote(quote, page);
  }

  function highlightQuote(quote, number = pageNumber) {
    const textLayer = pages[number - 1]?.slot.querySelector('.workbench-pdf__text-layer');
    if (!pdfDocument || !textLayer || !quote) return false;
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.previousSibling?.nodeName === 'BR') text += '\n';
      nodes.push({ node, start: text.length, end: text.length + node.textContent.length });
      text += node.textContent;
    }
    const normalized = quote.replace(/\r\n/g, '\n');
    const start = text.indexOf(normalized);
    if (start < 0) return false;
    const end = start + normalized.length;
    const startNode = nodes.find((entry) => start >= entry.start && start < entry.end);
    const endNode = nodes.find((entry) => end > entry.start && end <= entry.end);
    if (!startNode || !endNode) return false;
    const range = document.createRange();
    range.setStart(startNode.node, start - startNode.start);
    range.setEnd(endNode.node, end - endNode.start);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
    updateCaptureButton();
    return true;
  }

  async function open(url, page = 1) {
    const token = ++openToken;
    status.textContent = '正在打开 PDF';
    previousButton.disabled = true;
    nextButton.disabled = true;
    pageInput.disabled = true;
    container.querySelector('.workbench-pdf__zoom-in').disabled = true;
    container.querySelector('.workbench-pdf__zoom-out').disabled = true;
    resetZoomInput();
    cancelDraw();
    settleNavigation(false);
    for (const item of mounted) release(item);
    pages = [];
    lastScrollTop = 0;
    direction = 1;
    navigationAnchor = null;
    pageList.replaceChildren();
    pageLines.clear();
    const oldTask = loadingTask;
    loadingTask = null;
    pdfDocument = null;
    await oldTask?.destroy().catch(() => {});
    if (disposed || token !== openToken) return;
    const task = getDocument({
      url,
      cMapUrl: new URL('cmaps/', PDFJS_ASSET_BASE).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', PDFJS_ASSET_BASE).href,
      wasmUrl: new URL('wasm/', PDFJS_ASSET_BASE).href,
      useWorkerFetch: true,
      isEvalSupported: false,
    });
    loadingTask = task;

    try {
      const document = await task.promise;
      if (disposed || token !== openToken) {
        await document.destroy();
        return;
      }
      const initialPage = await document.getPage(Math.max(1, Math.min(document.numPages, Math.floor(page) || 1)));
      if (disposed || token !== openToken) return false;
      pdfDocument = document;
      fallbackSize = initialPage.getViewport({ scale: 1 });
      zoom = 0;
      fitWidth = viewport.clientWidth;
      const available = contentWidth();
      const fragment = window.document.createDocumentFragment();
      pages = Array.from({ length: document.numPages }, (_, index) => {
        const slot = window.document.createElement('div');
        slot.className = 'workbench-pdf__page-wrap';
        slot.dataset.pageNumber = index + 1;
        const item = { number: index + 1, slot };
        sizePage(item, available);
        fragment.append(slot);
        return item;
      });
      pageList.append(fragment);
      pageInput.disabled = false;
      pageInput.max = document.numPages;
      container.querySelector('.workbench-pdf__zoom-in').disabled = false;
      container.querySelector('.workbench-pdf__zoom-out').disabled = false;
      pageCount.textContent = `/ ${document.numPages}`;
      zoomLabel.textContent = '适合宽度';
      status.textContent = '';
      pageNumber = 0;
      const ready = await goToPage(page);
      return ready && !disposed && token === openToken;
    } catch (error) {
      if (disposed || token !== openToken) return;
      status.textContent = `无法打开 PDF：${error?.message || '文件无效或不可读取'}`;
      return false;
    }
  }

  function movePage(delta) {
    if (pdfDocument) void goToPage(pageNumber + delta);
  }

  function resizePages(newZoom, x, y) {
    if (!pages.length || !viewport.clientWidth) return;
    const frame = viewport.getBoundingClientRect();
    const anchorX = x ?? frame.left + viewport.clientWidth / 2;
    const anchorY = y ?? frame.top + Math.min(80, viewport.clientHeight / 2);
    const item = pages[pageAt(viewport.scrollTop + anchorY - frame.top)];
    const before = item.slot.getBoundingClientRect();
    const localX = (anchorX - before.left) / item.scale;
    const localY = (anchorY - before.top) / item.scale;
    zoom = newZoom;
    navigationAnchor = null;
    settleNavigation(false);
    fitWidth = viewport.clientWidth;
    zoomLabel.textContent = zoom ? `${Math.round(zoom * 100)}%` : '适合宽度';
    const available = contentWidth();
    for (const page of pages) sizePage(page, available);
    for (const mountedItem of mounted) {
      const { layer, scale } = mountedItem.render;
      const factor = mountedItem.scale / scale;
      layer.style.transform = `scale(${factor})`;
      layer.style.width = `${100 / factor}%`;
      layer.style.height = `${100 / factor}%`;
    }
    const after = item.slot.getBoundingClientRect();
    viewport.scrollLeft += after.left + localX * item.scale - anchorX;
    viewport.scrollTop += after.top + localY * item.scale - anchorY;
    lastScrollTop = viewport.scrollTop;
  }

  function resetZoomInput() {
    cancelAnimationFrame(zoomFrame);
    clearTimeout(zoomTimer);
    zoomFrame = zoomTimer = zoomSteps = 0;
    zoomAnchor = null;
  }

  function showZoomPreview() {
    zoomFrame = 0;
    if (!zoomAnchor) return;
    const nextScale = zoomSteps ? zoomAnchor.target : zoomAnchor.baseZoom;
    if (nextScale !== zoom) resizePages(nextScale, zoomAnchor.x, zoomAnchor.y);
  }

  function finishZoom(refresh = true) {
    cancelAnimationFrame(zoomFrame);
    showZoomPreview();
    resetZoomInput();
    if (refresh) refreshVisible();
  }

  function changeZoom(step, x, y) {
    if (!pages.length || !viewport.clientWidth) return;
    if (!zoomAnchor) {
      const frame = viewport.getBoundingClientRect();
      const anchorX = x ?? frame.left + viewport.clientWidth / 2;
      const anchorY = y ?? frame.top + Math.min(80, viewport.clientHeight / 2);
      const base = pages[pageAt(viewport.scrollTop + anchorY - frame.top)].scale;
      zoomAnchor = { x: anchorX, y: anchorY, baseZoom: zoom, base, target: base };
      cancelDraw();
    }
    zoomAnchor.x = x ?? zoomAnchor.x;
    zoomAnchor.y = y ?? zoomAnchor.y;
    const proposed = zoomSteps + step;
    const scale = Math.max(.35, Math.min(3, zoomAnchor.base * 1.15 ** proposed));
    if (scale !== zoomAnchor.target || !proposed) {
      zoomSteps = proposed;
      zoomAnchor.target = scale;
    }
    if (!zoomFrame) zoomFrame = requestAnimationFrame(showZoomPreview);
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(finishZoom, ZOOM_SETTLE_MS);
  }

  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey || !event.deltaY || !pages.length) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
  }, { passive: false });

  previousButton.addEventListener('click', () => movePage(-1));
  nextButton.addEventListener('click', () => movePage(1));
  document.addEventListener('selectionchange', onSelectionChange);
  for (const button of [captureButton, translateButton]) {
    button?.addEventListener('pointerdown', event => {
      if (event.button === 0 && selectedQuote()) event.preventDefault();
    });
  }
  captureButton?.addEventListener('click', async () => {
    const info = selectionPages();
    const quote = info?.selection.toString().trim();
    if (!quote || !pdfDocument) return;
    captureButton.disabled = true;
    status.textContent = '正在保存灵感卡片';
    try {
      const item = await onCreateIdea({ type: 'pdf', page: info.first.number, quote });
      status.textContent = item ? '已保存灵感卡片' : '已取消';
    } catch (error) {
      status.textContent = `保存失败：${error?.message || '请稍后重试'}`;
    } finally {
      updateCaptureButton();
    }
  });
  translateButton?.addEventListener('click', async () => {
    const info = selectionPages();
    const quote = info?.selection.toString().trim();
    if (!quote || !pdfDocument) return;
    translateButton.disabled = true;
    status.textContent = '正在读取选区';
    try {
      const page = info.first.number;
      const document = pdfDocument;
      const sentence = selectedSentence(info);
      const margins = await repeatedMarginLines(page, document).catch(() => []);
      if (disposed || document !== pdfDocument) return;
      const text = cleanPdfSelection(quote, margins);
      if (!text) { status.textContent = '选区中没有可翻译的文字'; return; }
      const pending = onTranslateSelection({ text, sentence: sentence || quote, page });
      status.textContent = '';
      await pending;
    } catch (error) {
      status.textContent = `无法打开翻译：${error?.message || '请稍后重试'}`;
    } finally {
      updateCaptureButton();
    }
  });
  container.querySelector('.workbench-pdf__zoom-in').addEventListener('click', () => changeZoom(1));
  container.querySelector('.workbench-pdf__zoom-out').addEventListener('click', () => changeZoom(-1));
  pageInput.addEventListener('change', () => {
    if (pageInputSubmitted) {
      pageInputSubmitted = false;
      return;
    }
    void goToPage(pageInput.value).catch(() => {});
  });
  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      pageInputSubmitted = true;
      pageInput.blur();
      void goToPage(pageInput.value).catch(() => {});
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!pdfDocument || disposed) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!zoom && !zoomAnchor && viewport.clientWidth > 0 && viewport.clientWidth !== fitWidth) {
        resizePages(0);
      }
      refreshVisible();
    });
  });
  resizeObserver.observe(viewport);

  return {
    open,
    goToPage,
    goToQuote,
    highlightQuote,
    dispose() {
      disposed = true;
      openToken++;
      resizeObserver.disconnect();
      document.removeEventListener('selectionchange', onSelectionChange);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(scrollFrame);
      resetZoomInput();
      cancelDraw();
      settleNavigation(false);
      for (const item of mounted) release(item);
      pages = [];
      void loadingTask?.destroy().catch(() => {});
      container.replaceChildren();
      container.classList.remove('workbench-pdf');
    },
    get page() {
      return pageNumber;
    },
    get total() {
      return pdfDocument?.numPages;
    },
  };
}
