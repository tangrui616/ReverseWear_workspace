export function samplePdf(pageCount = 2) {
  const pages = Array.from({ length: pageCount }, (_, index) => index);
  const font = pageCount * 2 + 3;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map(index => `${index + 3} 0 R`).join(' ')}] >>`,
    ...pages.map(index => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${index + pageCount + 3} 0 R >>`),
    ...pages.map(index => {
      const text = ['Stilltime verification - first page', 'Acoustic dataset - second page'][index] ?? `Stilltime page ${index + 1}`;
      const data = 'BT /F1 21 Tf 54 700 Td (' + text + ') Tj ET';
      return '<< /Length ' + data.length + ' >>\nstream\n' + data + '\nendstream';
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const start = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return start;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(start => String(start).padStart(10, '0') + ' 00000 n \n').join('');
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function sendMouseEvents(win, events) {
  const protocol = win.webContents.debugger;
  const wasAttached = protocol.isAttached();
  if (!wasAttached) protocol.attach('1.3');
  try {
    for (const event of events) await protocol.sendCommand('Input.dispatchMouseEvent', event);
  } finally {
    if (!wasAttached && protocol.isAttached()) protocol.detach();
  }
}

export function sendReaderWheel(win, { x, y }, { deltaY, ctrl = false, deltaX = 0 }) {
  return sendMouseEvents(win, [{ type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: ctrl ? 2 : 0 }]);
}

export function dragReaderScrollbar(win, { x, y, distance }) {
  return sendMouseEvents(win, [
    { type: 'mouseMoved', x, y },
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseMoved', x: x + distance, y, button: 'left', buttons: 1 },
    { type: 'mouseReleased', x: x + distance, y, button: 'left', clickCount: 1 },
  ]);
}
