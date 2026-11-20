import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { openRecentTags } from '../desktop_recent_tags.mjs';
import { WallpaperLibrary } from '../wallpaper_library_CodexV2.mjs';
import { createWorkbenchStore } from '../workbench-store.mjs';
import { openArticleStore } from '../desktop_articles.mjs';
import { createSceneDiagnostics } from '../desktop_scene_diagnostics.mjs';
import { createResearchStore } from '../research-store.mjs';
import { createDesktopRecords } from '../desktop_records.mjs';
import { createDesktopIdeas } from '../desktop_ideas.mjs';
import { createDesktopHistory } from '../desktop_history.mjs';
import { createDesktopMirror } from '../desktop_mirror.mjs';
import { createLinkSnapshots, createLocalSearch } from '../desktop_library_tools.mjs';
import { createMarkdownIndex } from '../desktop_incremental_index.mjs';
import { createBulkLinkTools } from '../desktop_bulk_links.mjs';
import { createManualLinkChecker } from '../desktop_link_check.mjs';
import { createDesktopInspirationBoard } from '../desktop_inspiration_board.mjs';
import { createGlobalSearch } from '../desktop_global_search.mjs';
import { createWeeklyReview } from '../desktop_weekly_review.mjs';
import { createDesktopIdeaRotation } from '../desktop_idea_rotation.mjs';
import { createDesktopDictionaries } from '../desktop_dictionaries.mjs';
import { createDesktopVocabulary } from '../desktop_vocabulary.mjs';
import { createOfflineTranslator } from '../desktop_translation_engines.mjs';
import { createLifeWorkbench } from '../desktop_life.mjs';
import { createWriteQueue } from './write-queue.mjs';

export const portablePath = value => typeof value === 'string' ? value.replaceAll('\\', '/') : '';

export async function createDataServices({ settings, DATA, suiteDirectory, fixtureRoot, articlePages, translationDirectory, sharedDictionaryCache, onIndexChange }) {
  const documentsDirectory = path.join(DATA, 'Documents');
  const toolsDirectory = path.join(settings.runtimeDirectory, 'Workbench');
  const storeOptions = { getDayStartMinutes: () => settings.getRiskPreferences().dayStartMinutes };
  const workbench = createWorkbenchStore(DATA, storeOptions);
  let articles;
  try {
    articles = await openArticleStore(path.join(suiteDirectory, 'Articles'), articlePages ? {
      fetchPage: async url => {
        const html = articlePages.get(url);
        if (!html) throw new Error('未找到隔离文章夹具。');
        return { html, finalUrl: url };
      },
      fetchAsset: async () => null,
    } : undefined);
  } catch (error) {
    console.error('文章收集箱初始化失败：', error.message);
    if (fixtureRoot) throw error;
  }
  let recentTags;
  const tagsHistory = () => recentTags ??= openRecentTags(DATA);
  async function saveWithTags(operation, tags) {
    const result = await operation;
    if (typeof tags === 'string') tags = tags.split(/[,，、;；\n]+/);
    if (result !== false && result?.duplicate !== true && result?.changed !== 0 &&
        Array.isArray(tags) && tags.some(tag => typeof tag === 'string' && tag.trim())) {
      try { tagsHistory().remember(tags); }
      catch (error) { console.warn('最近标签未更新：', error.message); }
    }
    return result;
  }
  const research = createResearchStore(DATA, storeOptions);
  const records = createDesktopRecords(documentsDirectory);
  const dictionaries = createDesktopDictionaries({ dictionariesDirectory: path.join(translationDirectory, 'Dictionaries'),
    cacheDirectory: sharedDictionaryCache ?? path.join(DATA, 'Translation', 'Runtime', 'Dictionaries') });
  const vocabulary = createDesktopVocabulary(documentsDirectory, storeOptions);
  const translator = createOfflineTranslator({ modelsDirectory: path.join(translationDirectory, 'Models'),
    runtimeDirectory: path.join(translationDirectory, 'Runtime') });
  const life = createLifeWorkbench(DATA, { getDayStartMinutes: () => settings.getRiskPreferences().dayStartMinutes });
  const markdown = createMarkdownIndex(documentsDirectory, {
    onChange: paths => onIndexChange([...new Set(paths.map(relative => relative.split(path.sep)[0].toLowerCase()))]),
  });
  const ideas = createDesktopIdeas(DATA, { ...storeOptions, index: markdown });
  const rotation = createDesktopIdeaRotation(ideas, storeOptions);
  const weeklyReview = createWeeklyReview(DATA, { ...storeOptions, ideas, getPreferences: () => settings.getRiskPreferences() });
  const globalSearch = createGlobalSearch(markdown, { documentsDirectory });
  const board = createDesktopInspirationBoard(DATA, { workbench, index: markdown });
  const bulkLinks = createBulkLinkTools({ documentsDirectory, settingsDirectory: settings.settingsDirectory });
  const checkLinks = createManualLinkChecker(workbench);
  const history = createDesktopHistory({
    documentsDirectory, settingsDirectory: settings.settingsDirectory, historyDirectory: path.join(toolsDirectory, 'History'),
  });
  const recordByPath = async relativePath => {
    const record = (await records.list()).find(item => portablePath(item.relativePath) === portablePath(relativePath));
    if (!record) throw new Error('找不到这份工作台 Markdown 记录。');
    return record;
  };
  const mirrorDirectory = path.join(DATA, 'AI-Mirror');
  const mirror = createDesktopMirror({
    documentsDirectory, mirrorDirectory,
    stateDirectory: path.join(toolsDirectory, 'Mirror'),
    beforeAccept: ({ relativePath, bytes }) => bytes == null ? history.ensureGitReady() : history.recordAcceptedRelativePath(portablePath(relativePath), 'AI 审核前版本'),
    onAccepted: ({ relativePath }) => history.recordAcceptedRelativePath(portablePath(relativePath), '接受 AI 修改'),
  });
  const linkSnapshots = createLinkSnapshots(DATA, workbench);
  const search = createLocalSearch({ documentsDirectory, index: markdown, cacheFile: path.join(toolsDirectory, 'search-index.json') });
  const gitSnapshots = reason => {
    const target = settings.getRiskPreferences().backupDirectory;
    const rootKey = createHash('sha256').update(DATA.toLowerCase()).digest('hex').slice(0, 12);
    return history.createSnapshot({ reason, externalDirectory: target ? path.join(target, 'ReverseWear-' + rootKey) : undefined });
  };
  const { serialize, afterWrites } = createWriteQueue();
  return {
    documentsDirectory, toolsDirectory, workbench, articles, tagsHistory, saveWithTags,
    research, records, dictionaries, vocabulary, translator, life, markdown, ideas, rotation,
    weeklyReview, globalSearch, board, bulkLinks, checkLinks, history, recordByPath, mirrorDirectory,
    mirror, linkSnapshots, search, gitSnapshots, serialize, afterWrites,
  };
}

export function createWallpaperServices({ settings, steamRoot, discoverAdditionalRoots }) {
  const openLibrary = folderRoots => new WallpaperLibrary({
    steamRoot, folderRoots, discoverAdditionalRoots,
  });
  let library = openLibrary(settings.getFolders());
  let refresh = false;
  const getLibrary = async () => {
    const pending = library.snapshot({ refresh });
    refresh = false;
    const snapshot = await pending;
    const warnings = [];
    for (const folder of snapshot.unavailableFolderRoots ?? []) {
      await readdir(folder).catch(error => {
        warnings.push(`${error.code === 'ENOENT' ? '壁纸目录不存在' : '无法读取壁纸目录'}：${folder}`);
      });
    }
    if (!snapshot.items.length && !warnings.length) warnings.push('当前没有可用的本地壁纸。可以连接图片、视频或 Workshop 文件夹。');
    return { ...snapshot, warnings };
  };
  const getItem = async id => {
    const snapshot = library.cache ?? await getLibrary();
    return snapshot.items.find(item => item.id === id) ?? null;
  };
  const updateFolders = folders => {
    settings.saveFolders(folders);
    library = openLibrary(folders);
  };

  return {
    getLibrary, getItem, updateFolders, requestLibraryRefresh: () => { refresh = true; },
    sceneDiagnostics: createSceneDiagnostics(),
  };
}
