const builtins = [
  { id: 'note.new', label: '新建 Markdown 笔记', description: '在工作台打开空白笔记' },
  { id: 'reader.open-pdf', label: '打开 PDF', description: '选择本地 PDF 并在文库阅读' },
  { id: 'translation.open', label: '离线翻译', description: '打开工作台的离线翻译页' },
];

export function calculate(input) {
  const source = String(input ?? '').trim();
  if (!source || source.length > 160) return null;
  const unit = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(px|rem)\s*(?:to|in|转|→|=)\s*(px|rem)$/i.exec(source);
  if (unit) {
    const [, value, from, to] = unit;
    const number = Number(value) * (from === to ? 1 : from.toLowerCase() === 'px' ? 1 / 16 : 16);
    return Number.isFinite(number) ? String(Number(number.toPrecision(12))) + ' ' + to.toLowerCase() : null;
  }
  const base = /^(0[xob][\da-f]+|\d+)\s*(?:to|in|转|→)\s*(bin|oct|dec|hex|2|8|10|16)$/i.exec(source);
  if (base) {
    const radix = { bin: 2, oct: 8, dec: 10, hex: 16 }[base[2].toLowerCase()] ?? Number(base[2]);
    try { return BigInt(base[1]).toString(radix); } catch { return null; }
  }
  const expression = source.replace(/^=\s*/, '').replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');
  if (!/^[\d\s.+*/%^()-]+$/.test(expression)) return null;
  const tokens = expression.match(/\d+(?:\.\d*)?|\.\d+|[+*/%^()-]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '')) return null;
  if (tokens.length > 100) return null;
  let index = 0;
  const binding = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  function parse(min = 0) {
    const prefix = tokens[index++];
    let value;
    if (prefix === '+' || prefix === '-') value = (prefix === '-' ? -1 : 1) * parse(3);
    else if (prefix === '(') {
      value = parse();
      if (tokens[index++] !== ')') throw new Error('括号不匹配');
    } else if (/^(?:\d|\.)/.test(prefix ?? '')) value = Number(prefix);
    else throw new Error('无效表达式');
    while (binding[tokens[index]] >= min) {
      const op = tokens[index++];
      const right = parse(binding[op] + (op === '^' ? 0 : 1));
      if (op === '+') value += right;
      else if (op === '-') value -= right;
      else if (op === '*') value *= right;
      else if (op === '/') value /= right;
      else if (op === '%') value %= right;
      else value **= right;
    }
    return value;
  }
  try {
    const value = parse();
    return index === tokens.length && Number.isFinite(value) ? String(Number(value.toPrecision(12))) : null;
  } catch { return null; }
}

export function launcherResults(query, records) {
  const value = String(query ?? '').trim().slice(0, 160);
  const result = calculate(value);
  const commands = builtins.filter(item => !value || (item.label + ' ' + item.description + ' ' + item.id).toLowerCase().includes(value.toLowerCase()));
  return [
    ...(result === null ? [] : [{ id: 'calculator.copy', label: result, description: '回车复制结果' }]),
    ...commands,
    ...records.slice(0, 12).map(item => ({
      id: 'snippet:' + item.id, label: item.preview || '看板片段',
      description: '看板片段 · ' + (item.characterCount ?? item.content?.text?.length ?? 0) + ' 字',
    })),
  ];
}
