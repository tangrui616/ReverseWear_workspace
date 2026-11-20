import path from 'node:path';
import { createHash } from 'node:crypto';
import { noteIdentityId, noteTitleFromMarkdown } from './desktop_note_identity.mjs';

const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const idPattern = /^(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const typeByFolder = {
  links: 'link', notes: 'note', daily: 'daily', weekly: 'weekly', memos: 'memo', weeklyreviews: 'weekly-review', experiments: 'experiment',
  linknotes: 'link-note', linkssnapshots: 'link-snapshot', ideas: 'idea', inspirationboard: 'inspiration-board',
  lifeexperiences: 'experience', moodjournal: 'mood', thinkingpages: 'thinking', contentboard: 'content', templates: 'template', customareas: 'custom',
};
const grams = value => {
  const chars = [...value];
  if (chars.length < 3) return [];
  const result = new Set();
  for (let index = 0; index <= chars.length - 3; index++) result.add(chars.slice(index, index + 3).join(''));
  return [...result];
};

function searchableRecord(entry, documentsDirectory) {
  const { metadata, body } = entry.parsed;
  const [directory, parentId] = entry.relativePath.split(/[\\/]/);
  const category = directory.toLowerCase();
  const type = typeByFolder[category] ?? 'document';
  const fallbackTitle = path.basename(entry.relativePath, path.extname(entry.relativePath));
  const title = category === 'notes'
    ? metadata.title || noteTitleFromMarkdown(body, fallbackTitle)
    : metadata.title || metadata.name || body.match(/^#\s+(.+)$/m)?.[1] || metadata.url || fallbackTitle;
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string') : [];
  const sourceLines = [...body.split(/\r?\n/).filter(line => !/^\s*<!--.*-->\s*$/.test(line)),
    ...[metadata.next, metadata.sourceNote, metadata.source?.quote, metadata.url].filter(value => typeof value === 'string')];
  const normalizedTitle = normalize(title);
  const normalizedTags = normalize(tags.join(' '));
  const content = [title, ...sourceLines, tags.join(' '), metadata.source?.url, metadata.source?.title].join('\n');
  const id = idPattern.test(metadata.id ?? '') ? metadata.id
    : category === 'notes' ? noteIdentityId(entry.relativePath)
      : createHash('sha1').update(path.resolve(documentsDirectory, entry.relativePath)).digest('hex').slice(0, 16);
  return {
    id, type, title, relativePath: entry.relativePath,
    updatedAt: entry.updatedAt, body, tags, normalized: normalize(content), sourceLines,
    normalizedTitle, normalizedTags, tagValues: tags.map(normalize),
    metadata: {
      fileId: metadata.fileId ?? null, page: metadata.page ?? null, related: metadata.related,
      linkId: metadata.linkId ?? (['link-note', 'link-snapshot'].includes(type) ? parentId : metadata.source?.linkId) ?? null,
    },
    area: metadata.area ?? metadata.domain ?? '',
    status: metadata.status ?? (type === 'experiment' ? metadata.completed ? 'done' : 'action' : ''),
    date: String(metadata.date || metadata.happenedAt || metadata.createdAt || metadata.created || metadata.updatedAt || entry.updatedAt || '').slice(0, 10),
  };
}

function matchesFilters(item, filters) {
  if (filters.area && item.area !== filters.area) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.tag && !item.tagValues.some(tag => tag.includes(filters.tag))) return false;
  if (filters.from && item.date < filters.from) return false;
  if (filters.to && item.date > filters.to) return false;
  return true;
}

function excerptFor(item, terms) {
  let bestLine = item.title;
  let bestScore = 0;
  let bestPosition = -1;
  for (let index = 0; index < item.sourceLines.length; index++) {
    const line = item.sourceLines[index];
    const folded = normalize(line);
    const positions = terms.map(term => folded.indexOf(term)).filter(value => value >= 0);
    const score = positions.length;
    if (score > bestScore || (score === bestScore && score > 0 && bestLine.startsWith('# '))) {
      bestLine = line; bestPosition = Math.min(...positions); bestScore = score;
    }
  }
  const start = Math.max(0, bestPosition - 90);
  const excerpt = bestLine.slice(start, start + 240) || item.title;
  const folded = normalize(excerpt);
  const matchRanges = [];
  for (const term of terms) {
    let from = 0;
    while (term && (from = folded.indexOf(term, from)) >= 0) {
      matchRanges.push([from, from + term.length]);
      from += Math.max(1, term.length);
    }
  }
  return { excerpt, anchor: excerpt.replace(/^\s*(?:#{1,6}|-)\s+/, '').trim(), matchRanges };
}

export function createGlobalSearch(markdownIndex, { documentsDirectory = process.cwd() } = {}) {
  let indexedRevision = -1;
  let records = new Map();
  let byId = new Map();
  const postings = new Map();

  function rebuild(entries, revision) {
    const next = new Map();
    for (const entry of entries) next.set(entry.relativePath, entry);
    for (const [relative, record] of records) {
      if (next.get(relative) === record.entry) continue;
      for (const gram of record.grams) {
        const bucket = postings.get(gram);
        bucket.delete(record);
        if (!bucket.size) postings.delete(gram);
      }
    }
    for (const [relative, entry] of next) {
      const prior = records.get(relative);
      if (prior?.entry === entry) { next.set(relative, prior); continue; }
      const record = searchableRecord(entry, documentsDirectory);
      record.entry = entry;
      record.grams = grams(record.normalized);
      for (const gram of record.grams) {
        if (!postings.has(gram)) postings.set(gram, new Set());
        postings.get(gram).add(record);
      }
      next.set(relative, record);
    }
    records = next;
    byId = new Map([...next.values()].map(item => [item.id, item]));
    indexedRevision = revision;
  }

  async function ready() {
    const snapshot = await markdownIndex.read();
    if (indexedRevision !== snapshot.revision) rebuild(snapshot.entries, snapshot.revision);
  }

  return {
    async query({ query = '', filters = {}, limit = 80 } = {}) {
      const started = performance.now();
      await ready();
      const terms = normalize(typeof query === 'string' ? query.slice(0, 240).trim() : '').split(/\s+/).filter(Boolean);
      filters = filters && typeof filters === 'object' ? { ...filters, tag: normalize(filters.tag).trim() } : {};
      if (!terms.length && !Object.values(filters).some(Boolean)) return { results: [], total: 0, elapsedMs: performance.now() - started, indexedCount: records.size };
      const sets = [...new Set(terms.flatMap(grams))].map(gram => postings.get(gram) ?? new Set()).sort((a, b) => a.size - b.size);
      const [candidateSet, ...remaining] = sets;
      const pool = candidateSet ?? records.values();
      const found = [];
      for (const item of pool) {
        if (!remaining.every(set => set.has(item)) || !matchesFilters(item, filters) || !terms.every(term => item.normalized.includes(term))) continue;
        const score = terms.reduce((sum, term) => sum + (item.normalizedTitle.includes(term) ? 8 : 0) + (item.normalizedTags.includes(term) ? 4 : 0), 0);
        found.push({ item, score });
      }
      found.sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
      const results = found.slice(0, Math.min(200, Math.max(1, Number(limit) || 80))).map(({ item }) => ({
        id: item.id, type: item.type, title: item.title, relativePath: item.relativePath, updatedAt: item.updatedAt,
        tags: item.tags, metadata: item.metadata, ...excerptFor(item, terms),
      }));
      return { results, total: found.length, elapsedMs: performance.now() - started, indexedCount: records.size };
    },
    async backlinks(id) {
      await ready();
      const target = byId.get(id);
      if (!target) return [];
      const references = [];
      for (const item of records.values()) {
        if (item.id === id) continue;
        const relation = Array.isArray(item.metadata.related) && item.metadata.related.includes(id);
        const targetPath = target.relativePath.split(path.sep).join('/');
        const markdownLink = item.body.includes(`(${targetPath})`) || item.body.includes(`](${targetPath}#`);
        const explicitId = item.body.includes(`[[${id}]]`) || item.body.includes(`(${id})`);
        const linkedByMetadata = item.metadata.linkId === id || item.metadata.source?.linkId === id;
        if (!relation && !markdownLink && !explicitId && !linkedByMetadata) continue;
        references.push({ id: item.id, type: item.type, title: item.title, relativePath: item.relativePath,
          updatedAt: item.updatedAt, metadata: item.metadata, anchor: item.body.split(/\r?\n/).find(line => line.includes(id))?.trim() ?? null,
          linkId: item.metadata.linkId ?? item.metadata.source?.linkId ?? null,
          fileId: item.metadata.fileId ?? null, page: Number.isInteger(item.metadata.page) ? item.metadata.page : null,
          reference: relation ? '关联灵感' : linkedByMetadata ? '来源关联' : '正文引用' });
      }
      return references.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
  };
}
