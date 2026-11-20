import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ITEMS = 500;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 256 * 1024 * 1024;
const DEFAULT_SETTINGS = Object.freeze({
  captureEnabled: false,
  autoPaste: false,
  stackEnabled: false,
  trayEnabled: false,
  selectionEnabled: false,
  plainSelectionCopy: false,
  ignoredProcesses: ['1password.exe', 'keepass.exe', 'keepassxc.exe'],
  maxItems: MAX_ITEMS,
  maxImageBytes: MAX_IMAGE_BYTES_TOTAL,
  shortcuts: {
    history: 'Alt+V',
    launcher: 'Control+Alt+Space',
    stack: 'Control+Alt+Shift+V',
    selection: 'Control+Alt+Shift+T',
    article: 'Control+Alt+Shift+S',
  },
});

const digest = (value) => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const byteLength = value => Buffer.byteLength(String(value ?? ''), 'utf8');
const checkedLimit = (value, fallback, maximum) => Number.isInteger(value) && value > 0
  ? Math.min(value, maximum) : fallback;

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, character => `\\${character}`);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\0/g, '');
}

function normalizeProcessNames(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map(item => path.basename(String(item).trim()).toLowerCase())
    .filter(item => /^[\p{L}\p{N}_.-]{1,128}$/u.test(item)))];
}

function recordHash(item) {
  if (item.type === 'image') return digest(item.imageBuffer);
  const content = item.type === 'files'
    ? [...new Set(item.files.map(file => path.resolve(file)))].sort().join('\n')
    : item.type === 'html' || item.type === 'rtf'
      ? JSON.stringify({ text: normalizeText(item.text), html: normalizeText(item.html), rtf: normalizeText(item.rtf) })
      : normalizeText(item.text);
  return digest(`${item.type}\0${content}`);
}

export async function openClipboardStore(directory, options = {}) {
  const root = path.resolve(directory);
  const imageDirectory = path.join(root, 'Images');
  await mkdir(imageDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(root, 'clipboard.sqlite'));
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      content_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      preview TEXT NOT NULL,
      source_name TEXT NOT NULL DEFAULT '',
      source_process TEXT NOT NULL DEFAULT '',
      foreground_process TEXT NOT NULL DEFAULT '',
      image_relative_path TEXT,
      image_bytes INTEGER NOT NULL DEFAULT 0,
      image_width INTEGER,
      image_height INTEGER,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS items_recent ON items(last_used_at DESC);
    CREATE INDEX IF NOT EXISTS items_type_recent ON items(type, last_used_at DESC);
    CREATE TABLE IF NOT EXISTS pinboards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pinboard_items (
      board_id TEXT NOT NULL REFERENCES pinboards(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(board_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS pinboard_items_order ON pinboard_items(board_id, position);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paste_stack (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      item_id UNINDEXED, search_text, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(item_id, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE OF search_text ON items BEGIN
      DELETE FROM items_fts WHERE item_id = old.id;
      INSERT INTO items_fts(item_id, search_text) VALUES (new.id, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
      DELETE FROM items_fts WHERE item_id = old.id;
    END;
  `);
  const itemColumns = new Set(database.prepare('PRAGMA table_info(items)').all().map(column => column.name));
  if (!itemColumns.has('foreground_process')) {
    database.exec("ALTER TABLE items ADD COLUMN foreground_process TEXT NOT NULL DEFAULT ''");
  }
  database.exec('DELETE FROM paste_stack');
  database.exec(`INSERT INTO items_fts(item_id,search_text)
    SELECT items.id,items.search_text FROM items
    WHERE NOT EXISTS (SELECT 1 FROM items_fts WHERE item_id=items.id)`);

  const getSettingStatement = database.prepare('SELECT value_json FROM settings WHERE key=?');
  const putSettingStatement = database.prepare(`INSERT INTO settings(key,value_json) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`);
  const insertItem = database.prepare(`INSERT INTO items (
    id,content_hash,type,content_json,search_text,preview,source_name,source_process,foreground_process,
    image_relative_path,image_bytes,image_width,image_height,created_at,last_used_at,usage_count
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  ON CONFLICT(content_hash) DO UPDATE SET
    last_used_at=excluded.last_used_at, usage_count=items.usage_count+1,
    source_name=excluded.source_name, source_process=excluded.source_process,
    foreground_process=excluded.foreground_process`);
  const getByHash = database.prepare('SELECT * FROM items WHERE content_hash=?');
  const getById = database.prepare('SELECT * FROM items WHERE id=?');
  const listBoardsStatement = database.prepare('SELECT * FROM pinboards ORDER BY position,name');
  const listRow = database.prepare(`SELECT items.*,
      EXISTS(SELECT 1 FROM pinboard_items WHERE item_id=items.id) AS pinned,
      (SELECT group_concat(p.name, ', ') FROM pinboard_items pi JOIN pinboards p ON p.id=pi.board_id WHERE pi.item_id=items.id) AS boards
    FROM items WHERE items.id=?`);

  const mapItem = row => row ? {
    id: row.id,
    type: row.type,
    content: JSON.parse(row.content_json),
    preview: row.preview,
    source: { name: row.source_name, process: row.source_process, foregroundProcess: row.foreground_process },
    image: row.image_relative_path ? {
      relativePath: row.image_relative_path,
      bytes: row.image_bytes,
      width: row.image_width,
      height: row.image_height,
    } : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count,
    pinned: Boolean(row.pinned),
    boards: row.boards ? row.boards.split(', ') : [],
  } : null;

  function getSettings() {
    const stored = getSettingStatement.get('preferences');
    const saved = stored ? JSON.parse(stored.value_json) : {};
    const processNames = normalizeProcessNames(saved.excludedProcesses ?? saved.ignoredProcesses, DEFAULT_SETTINGS.ignoredProcesses);
    const settings = { ...DEFAULT_SETTINGS, ...saved,
      ignoredProcesses: processNames,
      plainSelectionCopy: saved.selectionCopyFallback ?? saved.plainSelectionCopy ?? DEFAULT_SETTINGS.plainSelectionCopy,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(saved.shortcuts ?? {}) } };
    return { ...settings, excludedProcesses: settings.ignoredProcesses,
      selectionCopyFallback: settings.plainSelectionCopy };
  }

  function updateSettings(patch) {
    const current = getSettings();
    const excluded = patch?.excludedProcesses ?? patch?.ignoredProcesses;
    const processNames = Array.isArray(excluded) ? normalizeProcessNames(excluded) : current.ignoredProcesses;
    const shortcuts = { ...current.shortcuts };
    for (const key of Object.keys(shortcuts)) {
      if (typeof patch?.shortcuts?.[key] === 'string' && patch.shortcuts[key].length <= 64) {
        shortcuts[key] = patch.shortcuts[key];
      }
    }
    const next = {
      ...current,
      ...patch,
      captureEnabled: typeof patch?.captureEnabled === 'boolean' ? patch.captureEnabled : current.captureEnabled,
      autoPaste: typeof patch?.autoPaste === 'boolean' ? patch.autoPaste : current.autoPaste,
      stackEnabled: typeof patch?.stackEnabled === 'boolean' ? patch.stackEnabled : current.stackEnabled,
      trayEnabled: typeof patch?.trayEnabled === 'boolean' ? patch.trayEnabled : current.trayEnabled,
      selectionEnabled: typeof patch?.selectionEnabled === 'boolean' ? patch.selectionEnabled : current.selectionEnabled,
      plainSelectionCopy: typeof (patch?.selectionCopyFallback ?? patch?.plainSelectionCopy) === 'boolean'
        ? (patch.selectionCopyFallback ?? patch.plainSelectionCopy) : current.plainSelectionCopy,
      ignoredProcesses: processNames,
      shortcuts,
      maxItems: checkedLimit(patch?.maxItems ?? current.maxItems, MAX_ITEMS, 10_000),
      maxImageBytes: checkedLimit(patch?.maxImageBytes ?? current.maxImageBytes, MAX_IMAGE_BYTES_TOTAL, 4 * 1024 ** 3),
    };
    next.excludedProcesses = processNames;
    next.selectionCopyFallback = next.plainSelectionCopy;
    delete next.ignoredProcesses;
    delete next.plainSelectionCopy;
    putSettingStatement.run('preferences', JSON.stringify(next));
    next.ignoredProcesses = processNames;
    next.plainSelectionCopy = next.selectionCopyFallback;
    return next;
  }

  async function deleteUnreferencedImage(relativePath) {
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) return;
    const resolved = path.resolve(root, relativePath);
    if (path.dirname(resolved) !== imageDirectory) return;
    if (database.prepare('SELECT 1 FROM items WHERE image_relative_path=?').get(relativePath)) return;
    await unlink(resolved).catch(() => {});
  }

  function transaction(callback) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function addItem(input) {
    if (!input || !['text', 'html', 'rtf', 'link', 'color', 'image', 'files'].includes(input.type)) {
      throw new Error('剪贴板类型不受支持。');
    }
    if (input.type === 'image') {
      if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0 || input.imageBuffer.length > MAX_IMAGE_BYTES) {
        throw new Error('图片为空或超过 16 MiB 限制。');
      }
      if (!Number.isInteger(input.imageWidth) || !Number.isInteger(input.imageHeight) ||
          input.imageWidth <= 0 || input.imageHeight <= 0 || input.imageWidth * input.imageHeight > MAX_IMAGE_PIXELS) {
        throw new Error('图片尺寸为空或超过 32 MP 限制。');
      }
    } else if (input.type === 'files') {
      if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 256) {
        throw new Error('文件列表为空或包含超过 256 项。');
      }
    } else if (byteLength(input.text) > MAX_TEXT_BYTES || byteLength(input.html) > MAX_TEXT_BYTES || byteLength(input.rtf) > MAX_TEXT_BYTES) {
      throw new Error('剪贴板文本超过 1 MiB 限制。');
    }

    const imageHash = input.type === 'image' ? digest(input.imageBuffer) : null;
    const relativeImagePath = imageHash ? path.join('Images', `${imageHash}.png`) : null;
    const hashed = recordHash(input);
    const duplicate = getByHash.get(hashed);
    const now = input.capturedAt instanceof Date ? input.capturedAt.toISOString() : new Date(input.capturedAt ?? Date.now()).toISOString();
    const id = duplicate?.id ?? randomUUID();
    const content = input.type === 'image' ? { image: relativeImagePath }
      : input.type === 'files' ? { files: [...new Set(input.files.map(file => path.resolve(file)))] }
        : { text: normalizeText(input.text), html: normalizeText(input.html), rtf: normalizeText(input.rtf) };
    const searchText = input.type === 'image' ? ''
      : input.type === 'files' ? content.files.join('\n')
        : [content.text, content.html, content.rtf].filter(Boolean).join('\n');
    const preview = input.type === 'image' ? `图片 ${input.imageWidth} × ${input.imageHeight}`
      : input.type === 'files' ? content.files.slice(0, 3).map(file => path.basename(file)).join(' · ')
        : (content.text || content.html || content.rtf).trim().slice(0, 280);
    const sourceName = String(input.source?.name ?? '').slice(0, 200);
    const sourceProcess = String(input.source?.process ?? '').toLowerCase().slice(0, 260);
    const foregroundProcess = String(input.source?.foregroundProcess ?? '').toLowerCase().slice(0, 260);
    let temporaryImage = null;

    if (input.type === 'image' && !duplicate) {
      const target = path.join(root, relativeImagePath);
      const tempName = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempName, input.imageBuffer, { flag: 'wx' });
        await rename(tempName, target).catch(async error => {
          if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
          await unlink(tempName).catch(() => {});
        });
        temporaryImage = target;
      } catch (error) {
        await unlink(tempName).catch(() => {});
        throw error;
      }
    }

    try {
      transaction(() => insertItem.run(
        id, hashed, input.type, JSON.stringify(content), searchText, preview,
        sourceName, sourceProcess, foregroundProcess, duplicate?.image_relative_path ?? relativeImagePath,
        input.type === 'image' ? input.imageBuffer.length : 0,
        input.imageWidth ?? null, input.imageHeight ?? null,
        duplicate?.created_at ?? now, now,
      ));
    } catch (error) {
      if (temporaryImage && !getByHash.get(hashed)) await unlink(temporaryImage).catch(() => {});
      throw error;
    }

    if (input.boardId) setBoardItem(input.boardId, id, true);
    await enforceRetention(getSettings());
    return { item: getItem(id), duplicate: Boolean(duplicate) };
  }

  function getItem(id) {
    if (!validId(id)) return null;
    return mapItem(listRow.get(id));
  }

  function search(query = '', options = {}) {
    options ??= {};
    const requestedLimit = Number(options.limit);
    const requestedOffset = Number(options.offset);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    const conditions = [];
    const values = [];
    const cleanedQuery = normalizeText(query).replace(/\r\n?/g, '\n').trim().slice(0, 200);
    let join = '';
    if (options.boardId) {
      if (!validId(options.boardId)) return [];
      join = ' JOIN pinboard_items selected_board ON selected_board.item_id=items.id';
      conditions.push('selected_board.board_id=?');
      values.push(options.boardId);
    }
    if (options.type && options.type !== 'all' && ['text', 'html', 'rtf', 'link', 'color', 'image', 'files'].includes(options.type)) {
      conditions.push('items.type=?');
      values.push(options.type);
    }
    if (cleanedQuery) {
      if ([...cleanedQuery].length >= 3) {
        join += ' JOIN items_fts matched ON matched.item_id=items.id';
        conditions.push('items_fts MATCH ?');
        values.push(`"${cleanedQuery.replaceAll('"', '""')}"`);
      } else {
        conditions.push("items.search_text LIKE ? ESCAPE '\\'");
        values.push(`%${escapeLike(cleanedQuery)}%`);
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = database.prepare(`SELECT items.*,
      EXISTS(SELECT 1 FROM pinboard_items WHERE item_id=items.id) AS pinned,
      (SELECT group_concat(p.name, ', ') FROM pinboard_items pi JOIN pinboards p ON p.id=pi.board_id WHERE pi.item_id=items.id) AS boards
      FROM items${join}${where} ORDER BY items.last_used_at DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset);
    return rows.map(mapItem);
  }

  function listBoards() {
    return listBoardsStatement.all().map(row => ({ ...row,
      itemCount: database.prepare('SELECT COUNT(*) AS count FROM pinboard_items WHERE board_id=?').get(row.id).count,
    }));
  }

  function createBoard(name) {
    const normalized = String(name ?? '').trim().slice(0, 80);
    if (!normalized) throw new Error('看板名称不能为空。');
    const id = randomUUID();
    database.prepare('INSERT INTO pinboards(id,name,position,created_at) VALUES (?,?,?,?)')
      .run(id, normalized, listBoardsStatement.all().length, new Date().toISOString());
    return listBoards().find(board => board.id === id);
  }

  function renameBoard(id, name) {
    if (!validId(id)) throw new Error('看板 ID 无效。');
    const normalized = String(name ?? '').trim().slice(0, 80);
    if (!normalized) throw new Error('看板名称不能为空。');
    const result = database.prepare('UPDATE pinboards SET name=? WHERE id=?').run(normalized, id);
    return result.changes === 1;
  }

  async function deleteBoard(id) {
    if (!validId(id)) return false;
    const result = transaction(() => database.prepare('DELETE FROM pinboards WHERE id=?').run(id));
    if (result.changes !== 1) return false;
    await enforceRetention(getSettings());
    return result.changes === 1;
  }

  function setBoardItem(boardId, itemId, pinned) {
    if (!validId(boardId) || !validId(itemId)) throw new Error('看板或内容 ID 无效。');
    if (!database.prepare('SELECT 1 FROM pinboards WHERE id=?').get(boardId) || !getById.get(itemId)) {
      throw new Error('看板或剪贴板记录不存在。');
    }
    if (pinned) {
      database.prepare(`INSERT OR IGNORE INTO pinboard_items(board_id,item_id,position,created_at)
        VALUES (?,?,?,?)`).run(boardId, itemId,
        database.prepare('SELECT COUNT(*) AS count FROM pinboard_items WHERE board_id=?').get(boardId).count,
        new Date().toISOString());
    } else database.prepare('DELETE FROM pinboard_items WHERE board_id=? AND item_id=?').run(boardId, itemId);
    return getItem(itemId);
  }

  async function deleteItem(id) {
    if (!validId(id)) return false;
    const prior = getById.get(id);
    if (!prior) return false;
    database.prepare('DELETE FROM items WHERE id=?').run(id);
    await deleteUnreferencedImage(prior.image_relative_path);
    return true;
  }

  async function enforceRetention(settings = getSettings()) {
    const maxItems = checkedLimit(settings.maxItems, MAX_ITEMS, 10_000);
    const maxImageBytes = checkedLimit(settings.maxImageBytes, MAX_IMAGE_BYTES_TOTAL, 4 * 1024 ** 3);
    const totals = database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(items.image_bytes),0) AS imageBytes
      FROM items WHERE NOT EXISTS (SELECT 1 FROM pinboard_items WHERE item_id=items.id)`).get();
    if (totals.count <= maxItems && totals.imageBytes <= maxImageBytes) return;

    const ordinary = database.prepare(`SELECT items.id,items.image_relative_path,items.image_bytes FROM items
      WHERE NOT EXISTS (SELECT 1 FROM pinboard_items WHERE item_id=items.id)
      ORDER BY last_used_at DESC`).all();
    let count = ordinary.length;
    let imageBytes = ordinary.reduce((sum, row) => sum + row.image_bytes, 0);
    const victims = [];
    for (let index = ordinary.length - 1; index >= 0 && count > maxItems; index--) {
      const victim = ordinary[index];
      victims.push(victim);
      count--;
      imageBytes -= victim.image_bytes;
    }
    if (imageBytes > maxImageBytes) {
    const selectedVictims = new Set(victims.map(row => row.id));
    for (let index = ordinary.length - 1; index >= 0 && imageBytes > maxImageBytes; index--) {
        const victim = ordinary[index];
      if (!victim.image_bytes || selectedVictims.has(victim.id)) continue;
        victims.push(victim);
      selectedVictims.add(victim.id);
        count--;
        imageBytes -= victim.image_bytes;
      }
    }
    if (!victims.length) return;
    transaction(() => {
      const placeholders = victims.map(() => '?').join(',');
      if (victims.length > 64) {
        database.exec('DROP TRIGGER items_fts_delete');
        database.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...victims.map(row => row.id));
        database.exec(`DROP TABLE items_fts;
          CREATE VIRTUAL TABLE items_fts USING fts5(item_id UNINDEXED,search_text,tokenize='trigram');
          INSERT INTO items_fts(item_id,search_text)
          SELECT id,search_text FROM items;
          CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
            DELETE FROM items_fts WHERE item_id = old.id;
          END;`);
      } else {
        database.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...victims.map(row => row.id));
      }
    });
    const removed = victims.map(row => row.image_relative_path);
    for (const relativePath of removed) await deleteUnreferencedImage(relativePath);
  }

  function updateSettingsChecked(patch) {
    const next = updateSettings(patch);
    return enforceRetention(next).then(() => next);
  }

  async function clearHistory() {
    const rows = database.prepare(`SELECT items.id,items.image_relative_path FROM items
      WHERE NOT EXISTS (SELECT 1 FROM pinboard_items WHERE item_id=items.id)`).all();
    transaction(() => database.exec(`DELETE FROM items WHERE NOT EXISTS
      (SELECT 1 FROM pinboard_items WHERE item_id=items.id)`));
    for (const row of rows) await deleteUnreferencedImage(row.image_relative_path);
    return rows.length;
  }

  function itemImagePath(id) {
    if (!validId(id)) return null;
    const item = getById.get(id);
    if (!item?.image_relative_path || item.type !== 'image') return null;
    const resolved = path.resolve(root, item.image_relative_path);
    return path.dirname(resolved) === imageDirectory ? resolved : null;
  }

  function enqueueStack(item) {
    const contentJson = JSON.stringify(item);
    const count = database.prepare('SELECT COUNT(*) AS count FROM paste_stack').get().count;
    if (count >= 100) database.prepare('DELETE FROM paste_stack WHERE position=(SELECT MIN(position) FROM paste_stack)').run();
    database.prepare('INSERT INTO paste_stack(item_id,content_json,created_at) VALUES (?,?,?)')
      .run(String(item.id ?? ''), contentJson, new Date().toISOString());
    return count < 100 ? count + 1 : 100;
  }

  function peekStack() {
    return database.prepare('SELECT * FROM paste_stack ORDER BY position LIMIT 1').get() ?? null;
  }

  function popStack() {
    const first = peekStack();
    if (!first) return null;
    database.prepare('DELETE FROM paste_stack WHERE position=?').run(first.position);
    return JSON.parse(first.content_json);
  }

  function listStack() {
    return database.prepare('SELECT item_id,content_json FROM paste_stack ORDER BY position LIMIT 100')
      .all().map(row => {
        let item;
        try { item = JSON.parse(row.content_json); } catch { item = null; }
        return {
          id: String(item?.id ?? row.item_id ?? ''),
          preview: String(item?.preview ?? item?.content?.text ?? item?.content?.files?.[0] ?? '').slice(0, 280),
        };
      });
  }

  const getStats = () => database.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(image_bytes),0) AS imageBytes FROM items`).get();

  async function sweepImages() {
    const referenced = new Set(database.prepare('SELECT image_relative_path FROM items WHERE image_relative_path IS NOT NULL')
      .all().map(row => path.normalize(row.image_relative_path)));
    const entries = await readdir(imageDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp') || (entry.name.endsWith('.png') && !referenced.has(path.join('Images', entry.name)))) {
        await unlink(path.join(imageDirectory, entry.name)).catch(() => {});
      }
    }
  }

  await sweepImages();
  await enforceRetention(getSettings());
  return {
    root,
    close: () => database.close(),
    addItem,
    getItem,
    search,
    listBoards,
    createBoard,
    renameBoard,
    deleteBoard,
    setBoardItem,
    deleteItem,
    clearHistory,
    itemImagePath,
    getSettings,
    updateSettings: updateSettingsChecked,
    enqueueStack,
    peekStack,
    popStack,
    listStack,
    getStats,
  };
}
