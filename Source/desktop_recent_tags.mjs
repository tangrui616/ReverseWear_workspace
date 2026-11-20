import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_TAGS = 10;
const MAX_LENGTH = 120;

function cleanTag(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_LENGTH);
}

function normalizeTags(values) {
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const tag = cleanTag(value);
    const key = tag.toLocaleLowerCase('zh-CN');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

function writeAtomic(file, value) {
  const pending = `${file}.pending`;
  writeFileSync(pending, `${JSON.stringify({ version: 1, tags: value }, null, 2)}\n`, 'utf8');
  renameSync(pending, file);
}

export function openRecentTags(root) {
  const directory = path.resolve(root, 'Settings', 'Stilltime');
  const file = path.join(directory, 'recent-tags.json');
  mkdirSync(directory, { recursive: true });

  let tags = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      tags = normalizeTags(Array.isArray(parsed.tags) ? parsed.tags : []);
    } catch (error) {
      throw new Error(`无法读取最近标签：${error.message}`, { cause: error });
    }
  }

  return {
    list: () => [...tags],
    remember(values) {
      const next = normalizeTags([
        ...(Array.isArray(values) ? values : []),
        ...tags,
      ]);
      if (JSON.stringify(next) !== JSON.stringify(tags) || !existsSync(file)) writeAtomic(file, next);
      tags = next;
      return [...tags];
    },
  };
}
