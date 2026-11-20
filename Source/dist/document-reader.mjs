const requests = new WeakMap();

export function setupDocumentReaderZoom(viewport, toolbar) {
  if (!(viewport instanceof HTMLElement)) throw new TypeError('文档阅读区域无效。');
  let scale = 1;
  const controls = document.createElement('div');
  controls.className = 'document-reader__zoom';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '文档缩放');
  controls.innerHTML = '<button type="button" aria-label="缩小">−</button><span aria-live="polite">100%</span><button type="button" aria-label="放大">＋</button>';
  toolbar.append(controls);
  const [minus, value, plus] = controls.children;
  const content = () => viewport.querySelector('.document-reader__content');
  const resize = () => {
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (width > 0) viewport.style.setProperty('--document-reader-width', `${width}px`);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  const change = (direction, x, y) => {
    const article = content();
    if (!article) return;
    const nextScale = Math.max(.35, Math.min(3, scale * (direction > 0 ? 1.15 : 1 / 1.15)));
    if (nextScale === scale) return;
    const bounds = viewport.getBoundingClientRect();
    const before = article.getBoundingClientRect();
    const anchorX = x ?? bounds.left + viewport.clientWidth / 2;
    const anchorY = y ?? bounds.top + viewport.clientHeight / 2;
    const localX = (anchorX - before.left) / scale;
    const localY = (anchorY - before.top) / scale;
    scale = nextScale;
    viewport.style.setProperty('--document-reader-scale', String(scale));
    const after = article.getBoundingClientRect();
    viewport.scrollLeft += after.left + localX * scale - anchorX;
    viewport.scrollTop += after.top + localY * scale - anchorY;
    value.textContent = `${Math.round(scale * 100)}%`;
    minus.disabled = scale === .35;
    plus.disabled = scale === 3;
  };
  minus.addEventListener('click', () => change(-1));
  plus.addEventListener('click', () => change(1));
  const onWheel = event => {
    if (!event.ctrlKey || !event.deltaY || !content()) return;
    event.preventDefault();
    change(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
  };
  viewport.addEventListener('wheel', onWheel, { passive: false });
  return { dispose() {
    observer.disconnect();
    requests.get(viewport)?.abort();
    viewport.removeEventListener('wheel', onWheel);
    controls.remove();
  } };
}

export async function renderDocumentPreview(container, fileId) {
  if (!(container instanceof HTMLElement)) throw new TypeError('文档预览容器无效。');
  requests.get(container)?.abort();
  const controller = new AbortController();
  requests.set(container, controller);
  container.replaceChildren();
  container.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/workbench/document-render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || '文档读取失败。');
    if (requests.get(container) !== controller) return;
    const article = document.createElement('article');
    article.className = 'document-reader__content markdown-content';
    article.innerHTML = String(result.html ?? '');
    container.replaceChildren(article);
  } catch (error) {
    if (error.name !== 'AbortError' && requests.get(container) === controller) {
      const message = document.createElement('p');
      message.className = 'document-reader__error';
      message.textContent = error.message || '文档读取失败。';
      container.replaceChildren(message);
    }
  } finally {
    if (requests.get(container) === controller) {
      requests.delete(container);
      container.removeAttribute('aria-busy');
    }
  }
}

export function selectedDocumentText(container) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return '';
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return '';
  return selection.toString().trim();
}
