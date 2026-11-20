const shapes = {
  language: '<path d="M10 2h2v2h7v2h-2a14 14 0 0 1-4.3 7.5c.8.5 1.7 1 2.7 1.3l-.9 1.8c-1.3-.4-2.4-1-3.4-1.7-2 1.6-4.5 2.7-7.4 3.3l-.5-2c2.4-.5 4.5-1.4 6.2-2.6A14 14 0 0 1 5.8 8h2.1c.7 1.6 1.7 3 3.1 4.3A12 12 0 0 0 15 6H3V4h7zm8.4 11h2.2l3.4 9h-2l-.7-2h-3.6l-.7 2h-2zm1.1 2.5-1 2.8h2z"/>',
  bulb: '<path d="M9 19h6v2H9zm3-17a7 7 0 0 1 4.8 12.1c-.7.7-1 1.3-1 2.9H8.2c0-1.6-.3-2.2-1-2.9A7 7 0 0 1 12 2Zm0 2.3a4.7 4.7 0 0 0-3.2 8.1 6 6 0 0 1 1.5 2.4h3.4a6 6 0 0 1 1.5-2.4A4.7 4.7 0 0 0 12 4.3Z"/>',
  home: '<path d="M3 10.8 12 3l9 7.8v9.1a1.9 1.9 0 0 1-1.9 1.9h-4.2v-6.2h-5.8v6.2H4.9A1.9 1.9 0 0 1 3 19.9z"/>',
  link: '<path d="M9.5 14.5 14 10a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0l-.8-.8 2-2 .8.8a.7.7 0 0 0 1 0l3-3a.7.7 0 0 0-1-1l-4.5 4.5-2-2ZM14.5 9.5 10 14a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0l.8.8-2 2-.8-.8a.7.7 0 0 0-1 0l-3 3a.7.7 0 0 0 1 1l4.5-4.5 2 2Z"/>',
  note: '<path d="M6 3h10.6L21 7.4V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 5 20V4.5A1.5 1.5 0 0 1 6.5 3Zm9.8 1.8v3.7h3.7zM8 12h8.5v1.8H8zm0 4h8.5v1.8H8z"/>',
  file: '<path d="M6 2.8h8.2L20 8.6v11.9a1.7 1.7 0 0 1-1.7 1.7H6a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2Zm7.3 1.9v4.5h4.5zM8 13h8v1.8H8zm0 3.8h8v1.8H8z"/>',
  timer: '<path d="M9 2h6v2H9zm3 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm1 9.4 3.2 1.9-1 1.7-4.2-2.5V9h2z"/>',
  flask: '<path d="M9 2.5h6v2h-1v5.2l5.7 8.7a2.4 2.4 0 0 1-2 3.7H6.3a2.4 2.4 0 0 1-2-3.7L10 9.7V4.5H9zM8.6 15l-2.5 3.8c-.2.3 0 .6.3.6h11.2c.3 0 .5-.3.3-.6L15.4 15z"/>',
  plan: '<path d="M7 2.5h2v3H7zm8 0h2v3h-2zM5 4h2v2H5a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2V4h2a4 4 0 0 1 4 4v11.5a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Zm1 8h12v2H6zm0 4h8v2H6z"/>',
  palette: '<path d="M12 2a10 10 0 1 0 0 20h1.2a2.7 2.7 0 0 0 1.8-4.7 1.1 1.1 0 0 1 .7-1.9H18a4 4 0 0 0 4-4C22 6.2 17.5 2 12 2ZM7 13.2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3.2-4.6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4.6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>',
  sun: '<path d="M11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4 4l1.4-1.4 2.1 2.1L6.1 6.1zm12.5 12.5 1.4-1.4 2.1 2.1-1.4 1.4zM20 4l-2.1 2.1-1.4-1.4 2.1-2.1zM7.5 16.5l-2.1 2.1L4 17.2l2.1-2.1zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"/>',
  moon: '<path d="M20.9 14.3A8.7 8.7 0 0 1 9.7 3.1 9.2 9.2 0 1 0 20.9 14.3Z"/>',
  desktop: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v11h16V5z"/>',
  check: '<path d="M9.2 16.3 4.8 12l-2 2 6.4 6.4L21.5 8l-2-2z"/>',
  close: '<path d="m5.3 4 6.7 6.7L18.7 4 20 5.3l-6.7 6.7L20 18.7 18.7 20 12 13.3 5.3 20 4 18.7l6.7-6.7L4 5.3z"/>',
  plus: '<path d="M11 3h2v8h8v2h-8v8h-2v-8H3v-2h8z"/>',
  minus: '<path d="M3 11h18v2H3z"/>',
  arrowLeft: '<path d="m10.4 4-8 8 8 8 1.5-1.5L6.5 13H22v-2H6.5l5.4-5.5z"/>',
  arrowUpRight: '<path d="M5 4h15v15h-2V7.4L5.7 19.7l-1.4-1.4L16.6 6H5z"/>',
  chevronLeft: '<path d="m14.8 4-8 8 8 8 1.4-1.4L9.6 12l6.6-6.6z"/>',
  chevronRight: '<path d="m9.2 4 8 8-8 8-1.4-1.4 6.6-6.6-6.6-6.6z"/>',
  search: '<path d="M10.8 2a8.8 8.8 0 1 0 5.5 15.7l4.1 4.1 1.4-1.4-4.1-4.1A8.8 8.8 0 0 0 10.8 2Zm0 2a6.8 6.8 0 1 1 0 13.6 6.8 6.8 0 0 1 0-13.6Z"/>',
  upload: '<path d="M11 16h2V7.8l3.1 3.1 1.4-1.4L12 4l-5.5 5.5 1.4 1.4L11 7.8zM4 15v4h16v-4h2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z"/>',
  reset: '<path d="M4 4v6h6L7.8 7.8a7 7 0 1 1-1.4 7.5l-1.9.7A9 9 0 1 0 6.4 6.4L4 4Zm7 4h2v4.4l3 1.8-1 1.7-4-2.4z"/>',
  play: '<path d="M7 4.5a1 1 0 0 1 1.5-.9l11 7a1.7 1.7 0 0 1 0 2.8l-11 7A1 1 0 0 1 7 19.5z"/>',
  pause: '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>',
  volume: '<path d="M3 9v6h4l5 4V5L7 9zm12.5 3a3.5 3.5 0 0 0-2-3.2v6.4a3.5 3.5 0 0 0 2-3.2Zm-2-8v2.1a6.5 6.5 0 0 1 0 11.8V20a8.5 8.5 0 0 0 0-16Z"/>',
  volumeMute: '<path d="M3 9v6h4l5 4V5L7 9zm12.4 0 1.4 1.4 1.4-1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.4-1.4z"/>',
  fullscreen: '<path d="M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z"/>',
  sliders: '<path d="M4 6h5v2H4zm9 0h7v2h-7zM4 16h9v2H4zm13 0h3v2h-3zM9 4h4v6H9zm4 9h4v6h-4z"/>',
  shuffle: '<path d="M17 3h5v5h-2V6.4l-4.2 4.2-1.4-1.4L18.6 5H17zm-15 3h3.2c2 0 3.6 1 5 2.8l5.6 7.4c1 1.2 1.8 1.8 3.2 1.8h1v-2h2v5h-3v-1h-1c-2 0-3.6-1-5-2.8L7.4 9.8C6.4 8.6 5.6 8 4.2 8H2zm15 9h5v5h-2v-1.6l-3.2-3.2zM2 16h2.2c1.3 0 2.1-.5 3.1-1.7l.7-.9 1.3 1.5-.5.6c-1.4 1.8-3 2.5-4.8 2.5H2z"/>',
  image: '<path d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v14h16V5zm3 11 3.3-4 2.7 3 1.8-2 3.2 4H5.5zM16 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>',
  heart: '<path d="M12 21 3.7 12.8a5.3 5.3 0 0 1 7.5-7.5l.8.8.8-.8a5.3 5.3 0 0 1 7.5 7.5z"/>',
  infinity: '<path d="M6.6 6.4c2.5 0 4.1 1.8 5.4 3.5 1.3-1.7 2.9-3.5 5.4-3.5a5.6 5.6 0 1 1 0 11.2c-2.5 0-4.1-1.8-5.4-3.5-1.3 1.7-2.9 3.5-5.4 3.5a5.6 5.6 0 0 1 0-11.2Zm0 2.5a3.1 3.1 0 1 0 0 6.2c1.5 0 2.7-1.4 3.8-3.1-1.1-1.7-2.3-3.1-3.8-3.1Zm10.8 0c-1.5 0-2.7 1.4-3.8 3.1 1.1 1.7 2.3 3.1 3.8 3.1a3.1 3.1 0 0 0 0-6.2Z"/>',
};

const navPaths = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  bulb: 'M9 18h6m-5 3h4M8.5 15a6 6 0 1 1 7 0c-.6.5-1 1.2-1 2h-5c0-.8-.4-1.5-1-2Z',
  plan: 'M7 3v4m10-4v4M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm-2 5h18M7 14h6m-6 3h4',
  link: 'M10 8l2.4-2.4a4 4 0 0 1 5.7 5.7L16 13.5M14 16l-2.4 2.4a4 4 0 0 1-5.7-5.7L8 10.5m1.5 4 5-5',
  note: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
  flask: 'M9 3h6m-5 0v7l-5.5 8.5A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.5-2.5L14 10V3M8 15h8',
  file: 'M5 3h9l5 5v13H5zM14 3v5h5',
  language: 'M3 5h12M9 2v3m4 0c-1 5-4 9-9 12m2-9c1 3 3 5 6 7m1 6 4-9 4 9m-6.5-3h5',
  heart: 'M12 21 4.3 13.3a5.3 5.3 0 0 1 0-7.5 5 5 0 0 1 7.4.3l.3.3.3-.3a5 5 0 0 1 7.4-.3 5.3 5.3 0 0 1 0 7.5Z',
  timer: 'M10 2h4m-2 0v3m5.7 1.8 1.5-1.6M12 9v5l3 1.5M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
};

const svgNamespace = 'http://www.w3.org/2000/svg';

export function createWorkbenchIcon(name, className = 'wb-fa-icon') {
  if (!Object.hasOwn(shapes, name)) return null;
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add(className);
  const path = document.createElementNS(svgNamespace, 'path');
  const pathData = shapes[name].match(/d="([^"]+)"/)?.[1];
  if (!pathData) return null;
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

export function renderWorkbenchIcons(root) {
  root.querySelectorAll('[data-wb-icon]').forEach(element => {
    if (element.firstElementChild?.matches('.wb-fa-icon,.mac-nav-icon')) return;
    const name = element.dataset.wbIcon;
    const path = element.closest('.wb-nav,.wb-focus-nav') ? navPaths[name] : null;
    const svg = createWorkbenchIcon(name, path ? 'mac-nav-icon' : 'wb-fa-icon');
    if (path) svg.firstElementChild.setAttribute('d', path);
    if (svg) element.replaceChildren(svg);
  });
}
