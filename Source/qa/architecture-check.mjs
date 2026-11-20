import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const CODE_FILE = /\.(?:mjs|cjs|js)$/i;
const DISK_IGNORE_SEGMENTS = new Set(['node_modules', 'release', '.cache', '.git', '.electron-45', '.toolset', '.suite-native']);
const GRAPH_IGNORE_SEGMENTS = new Set(['qa', 'tests', 'vendor']);
const SPECIAL_DIST_SEGMENTS = new Set(['wallpapers', 'ouroboros']);
const ASSEMBLY_NAME = /(?:^|\/)(?:bootstrap|entry|app|workbench|start|index)\.(?:mjs|js|cjs)$/i;

const toPosix = value => value.split(path.sep).join('/');

function isGraphIgnored(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some(part => GRAPH_IGNORE_SEGMENTS.has(part))) return true;
  return parts[0] === 'dist' && parts.some(part => SPECIAL_DIST_SEGMENTS.has(part));
}

function layerOf(relativePath) {
  if (relativePath.startsWith('dist/')) return 'renderer';
  if (relativePath.startsWith('main/')) return 'main';
  if (relativePath.startsWith('ipc/')) return 'ipc';
  if (relativePath.startsWith('desktop_suite/')) return 'desktop_suite';
  return 'root';
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!DISK_IGNORE_SEGMENTS.has(entry.name)) await visit(absolute);
      } else if (!DISK_IGNORE_SEGMENTS.has(entry.name)) {
        files.push(relative);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function moduleSpecifiers(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) { index++; continue; }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index < 0) break;
      index += 2;
      continue;
    }
    if (character === '`') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '`') break;
        else continue;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          const next = source[index + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          index += 2;
        } else value += source[index++];
      }
      index++;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (/[\w$]/.test(source[index] ?? '')) index++;
      tokens.push({ type: 'identifier', value: source.slice(start, index) });
      continue;
    }
    tokens.push({ type: 'punctuation', value: character });
    index++;
  }
  const values = new Map();
  const add = (kind, specifier) => values.set(`${kind}:${specifier}`, { kind, specifier });
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === 'import') {
      if (tokens[index + 1]?.value === '.' || tokens[index + 1]?.value === 'meta') continue;
      if (tokens[index + 1]?.value === '(') {
        if (tokens[index + 2]?.type === 'string') add('dynamic', tokens[index + 2].value);
        continue;
      }
      if (tokens[index + 1]?.type === 'string') { add('static', tokens[index + 1].value); continue; }
    } else if (token.value === 'require' && tokens[index + 1]?.value === '(') {
      if (tokens[index + 2]?.type === 'string') add('require', tokens[index + 2].value);
      continue;
    } else if (token.value !== 'export') continue;
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor++) {
      if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
        add('static', tokens[cursor + 1].value);
        index = cursor + 1;
        break;
      }
    }
  }
  return [...values.values()];
}

async function resolveLocal(root, from, specifier, allFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(from), specifier);
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(...['.mjs', '.cjs', '.js', '.json', '.node', '.py'].map(extension => base + extension));
    candidates.push(...['index.mjs', 'index.cjs', 'index.js', 'index.json'].map(name => path.join(base, name)));
  }
  const known = new Set([...allFiles].map(file => path.resolve(root, file)));
  const found = candidates.find(candidate => known.has(candidate));
  return found ? toPosix(path.relative(root, found)) : null;
}

function stronglyConnected(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lows = new Map();
  const stack = [];
  const stacked = new Set();
  const cycles = [];
  function visit(vertex) {
    indices.set(vertex, nextIndex);
    lows.set(vertex, nextIndex++);
    stack.push(vertex);
    stacked.add(vertex);
    for (const target of graph.get(vertex) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lows.set(vertex, Math.min(lows.get(vertex), lows.get(target)));
      } else if (stacked.has(target)) {
        lows.set(vertex, Math.min(lows.get(vertex), indices.get(target)));
      }
    }
    if (lows.get(vertex) !== indices.get(vertex)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      stacked.delete(member);
      component.push(member);
    } while (member !== vertex);
    if (component.length > 1 || (graph.get(vertex) ?? []).includes(vertex)) cycles.push(component.sort());
  }
  for (const vertex of graph.keys()) if (!indices.has(vertex)) visit(vertex);
  return cycles;
}

function compileGlob(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        index++;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(expression + '$');
}

function includedByBuildFiles(file, patterns) {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith('!');
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (compileGlob(pattern).test(file)) included = !excluded;
  }
  return included;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
}

function contractDigest(value) {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

async function inspectSource(root, baseline, files, issues) {
  const modules = files.filter(file => CODE_FILE.test(file) && !isGraphIgnored(file));
  const allFiles = new Set(files);
  const graph = new Map(modules.map(file => [file, []]));
  const edges = new Set();
  const unresolved = [];
  const preloadAccess = [];
  const lines = new Map();

  for (const file of modules) {
    const source = await readFile(path.join(root, file), 'utf8');
    lines.set(file, source.split(/\r?\n/).length);
    if (file.startsWith('dist/') && /\bwindow\s*\.\s*stilltimeDesktop\b/.test(source)) preloadAccess.push(file);
    for (const { kind, specifier } of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = await resolveLocal(root, file, specifier, allFiles);
      if (!target) {
        if (kind === 'static') unresolved.push(`${file} -> ${specifier}`);
        continue;
      }
      if (isGraphIgnored(target)) continue;
      if (CODE_FILE.test(target)) graph.get(file).push(target);
      if (layerOf(file) !== layerOf(target)) edges.add(`${file} -> ${target}`);
    }
  }

  for (const item of unresolved) issues.push(`本地模块未解析：${item}`);
  for (const cycle of stronglyConnected(graph)) issues.push(`静态依赖循环：${cycle.join(' -> ')}`);

  const allowedEdges = new Set(baseline.crossLayerEdges);
  const addedEdges = [...edges].filter(edge => !allowedEdges.has(edge)).sort();
  for (const edge of addedEdges) issues.push(`新增跨层依赖：${edge}`);

  const allowedPreload = new Set(baseline.directPreloadAccess);
  for (const file of preloadAccess) if (!allowedPreload.has(file)) issues.push(`新增 Renderer preload 直连：${file}`);

  const allowedLarge = baseline.largeModules;
  for (const [file, count] of lines) {
    if (count > 500 && !(file in allowedLarge)) issues.push(`新增超 500 行模块：${file}（${count} 行）`);
  }
  for (const [file, maximum] of Object.entries(allowedLarge)) {
    const actual = lines.get(file);
    if (actual === undefined) continue;
    if (actual > maximum) issues.push(`模块行数增长：${file}（基线 ${maximum}，当前 ${actual}）`);
  }

  for (const [file, maximum] of Object.entries(baseline.assemblyDebt)) {
    const actual = lines.get(file);
    if (actual !== undefined && actual > maximum) issues.push(`装配入口行数增长：${file}（基线 ${maximum}，当前 ${actual}）`);
  }
  for (const [file, count] of lines) {
    if (count > 300 && ASSEMBLY_NAME.test(file) && !(file in baseline.assemblyDebt)) {
      issues.push(`新增超 300 行装配入口：${file}（${count} 行）`);
    }
  }

  const styles = files.filter(file => file.endsWith('.css'));
  const styleLines = new Map();
  for (const file of styles) {
    styleLines.set(file, (await readFile(path.join(root, file), 'utf8')).split(/\r?\n/).length);
  }
  for (const [file, count] of styleLines) {
    if (count > 500 && !(file in baseline.largeStyles)) issues.push(`新增超 500 行样式：${file}（${count} 行）`);
  }
  for (const [file, maximum] of Object.entries(baseline.largeStyles)) {
    const actual = styleLines.get(file);
    if (actual !== undefined && actual > maximum) issues.push(`样式行数增长：${file}（基线 ${maximum}，当前 ${actual}）`);
  }

  return {
    modules: modules.length,
    cycles: stronglyConnected(graph).length,
    crossLayerEdges: edges.size,
    directPreloadFiles: preloadAccess.length,
    largeModules: [...lines].filter(([, count]) => count > 500).length,
    largeStyles: [...styleLines].filter(([, count]) => count > 500).length,
    assemblyDebt: Object.keys(baseline.assemblyDebt).length,
  };
}

async function inspectIpc(root, baseline, issues) {
  const contractUrl = pathToFileURL(path.join(root, 'ipc', 'contract.mjs'));
  contractUrl.searchParams.set('architecture', String(Date.now()));
  const contract = await import(contractUrl.href);
  const actual = {};
  for (const key of ['commands', 'events', 'suiteOperations']) {
    actual[key] = { count: Object.keys(contract[key]).length, sha256: contractDigest(contract[key]) };
    const expected = baseline.ipcContracts[key];
    if (actual[key].count !== expected.count || actual[key].sha256 !== expected.sha256) {
      issues.push(`IPC 契约变化：${key} 基线 ${expected.count}/${expected.sha256}，当前 ${actual[key].count}/${actual[key].sha256}`);
    }
  }
  const check = spawnSync(process.execPath, ['ipc/generate-preloads.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  if (check.error || check.status !== 0) {
    const detail = [check.error?.message, check.stdout, check.stderr].filter(Boolean).join('\n').trim();
    issues.push(`preload 生成检查失败${detail ? `：${detail}` : ''}`);
  }
  return actual;
}

async function inspectBuildCoverage(root, baseline, files, issues) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const patterns = packageJson.build?.files;
  if (!Array.isArray(patterns)) {
    issues.push('package.json 缺少 build.files 白名单');
    return { reachable: 0, uncovered: [] };
  }
  const known = new Set(files);
  const queue = ['main.mjs'];
  const visited = new Set();
  const uncovered = [];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!known.has(file)) {
      issues.push(`运行入口依赖不存在：${file}`);
      continue;
    }
    if (!includedByBuildFiles(file, patterns)) uncovered.push(file);
    if (!CODE_FILE.test(file)) continue;
    const source = await readFile(path.join(root, file), 'utf8');
    for (const { specifier } of moduleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = await resolveLocal(root, file, specifier, known);
      const edge = `${file} -> ${target ?? specifier}`;
      if (baseline.developmentOnlyImports.includes(edge)) continue;
      if (!target) issues.push(`运行依赖未解析：${file} -> ${specifier}`);
      else if (!visited.has(target)) queue.push(target);
    }
  }
  for (const file of uncovered) issues.push(`构建白名单遗漏运行模块：${file}`);
  return { reachable: visited.size, uncovered };
}

export async function runArchitectureChecks({ root = DEFAULT_ROOT, baselinePath = path.join(root, 'qa', 'architecture-baseline.json') } = {}) {
  root = path.resolve(root);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const issues = [];
  const files = await listFiles(root);
  const source = await inspectSource(root, baseline, files, issues);
  const ipc = await inspectIpc(root, baseline, issues);
  const build = await inspectBuildCoverage(root, baseline, files, issues);
  return { ok: issues.length === 0, summary: { ...source, ipc, buildReachable: build.reachable }, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runArchitectureChecks();
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, issues: [error.message] }) + '\n');
    process.exitCode = 1;
  }
}
