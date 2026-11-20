const OUROBOROS_ORIGIN = 'https://stilltime-ouroboros.invalid';

export function mountOuroborosFrame(container) {
  const frame = document.createElement('iframe');
  frame.className = 'wb-ouroboros-frame';
  frame.title = '衔尾蛇无限循环 V9';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.referrerPolicy = 'no-referrer';
  const initialTheme = document.documentElement.dataset.theme;
  frame.src = OUROBOROS_ORIGIN + '/host.html' + (initialTheme === 'dark' ? '?night' : '');

  const syncTheme = () => {
    frame.contentWindow?.postMessage({ type: 'stilltime-theme', theme: document.documentElement.dataset.theme }, OUROBOROS_ORIGIN);
  };
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  frame.addEventListener('load', syncTheme);
  container.replaceChildren(frame);

  return {
    dispose() {
      observer.disconnect();
      frame.removeEventListener('load', syncTheme);
      frame.src = 'about:blank';
      frame.remove();
    },
  };
}
