/**
 * Shared Electron IPC channel contract.
 *
 * Keys omit the stilltime: prefix. Keep the wire names stable when moving
 * handlers between modules.
 *
 * @typedef {Object} CommandContract
 * @property {string} channel Full Electron channel name.
 * @property {boolean} write Whether the operation uses the serialized write queue.
 * @property {boolean} capture Whether capture-window authorization applies.
 * @property {boolean} capturePopup Whether the quick-capture popup may invoke it.
 * @property {string[]} methods Public preload methods using this command.
 *
 * @typedef {Object} EventContract
 * @property {string} channel Full Electron event channel name.
 * @property {string[]} methods Public preload subscriptions.
 * @property {string[]} recipients Window roles that receive the event.
 *
 * @typedef {Object} SuiteOperationContract
 * @property {string[]} roles Window roles that may invoke the operation.
 * @property {boolean} write Whether the operation uses the suite serial queue.
 *
 *
 * @typedef {{
 *   'window:state': { maximized: boolean, fullscreen: boolean },
 *   'window:quit-request': number,
 *   'articles:changed': { articleId: string },
 *   'articles:clipboard-link': { preview: string, id: string },
 *   'articles:clipboard-result': unknown,
 *   'suite:workbench-action': { command: string, fileId?: string },
 *   'index:changed': string[],
 *   'capture:saved': unknown,
 *   'capture:appearance': string,
 *   'capture:source': string,
 *   'risk:activity': boolean,
 *   'risk:backup-error': string,
 *   'risk:mirror-changed': { pending: number, busy: boolean }|{ error: string },
 *   'suite:changed': { shown?: boolean, appearance?: 'dark'|'light', palette?: string, material?: string, glassBlur?: number },
 *   'suite:clipboard-changed': void,
 *   'browser:state': {url:string,title:string,loading:boolean,canGoBack:boolean,canGoForward:boolean,error?:string},
 * }} EventPayloadMap
 */

/**
 * Argument tuples are listed in renderer order. Opaque business payloads use
 * Record<string, unknown>; the concrete records remain owned by their
 * corresponding store modules.
 *
 * @typedef {{
 *   'window:ready': [],
 *   'window:control': [command: string],
 *   'window:quit-result': [requestId: number, close: boolean],
 *   'suite:open': [],
 *   'suite:clipboard-invoke': [operation: string, input?: Record<string,unknown>],
 *   'suite:clipboard-read-text': [],
 *   'suite:clipboard-write-text': [value: string],
 *   'appearance:window-material': [value:{material:'solid'|'glass',glassBlur:number}],
 *   'prompts:list': [],
 *   'prompts:save': [input: {id?:string,title:string,body:string}],
 *   'browser:state': [],
 *   'browser:navigate': [url: string],
 *   'browser:back': [],
 *   'browser:forward': [],
 *   'browser:reload': [],
 *   'browser:hide': [],
 *   'browser:bounds': [bounds: {x:number,y:number,width:number,height:number}],
 *   'browser:open-external': [],
 *   'articles:capture-clipboard': [input: { id: string }],
 *   'articles:list': [input?: Record<string, unknown>],
 *   'articles:get': [input: { id: string }],
 *   'articles:capture': [input: { url: string }],
 *   'articles:update': [input: Record<string, unknown>],
 *   'articles:highlight': [input: Record<string, unknown>],
 *   'articles:open-link': [input: { url: string }],
 *   'articles:delete': [input: { id: string }],
 *   'articles:annotation-remove': [input: { id: string, annotationId: string }],
 *   'articles:translate': [input: { text: string }],
 *   'articles:export': [input: Record<string, unknown>],
 *   'tags:recent': [],
 *   'life:list': [input?: Record<string, unknown>],
 *   'life:get': [input: { id: string }],
 *   'life:save': [input: Record<string, unknown>],
 *   'life:template-save': [input: Record<string, unknown>],
 *   'life:append-timeline': [input: Record<string, unknown>],
 *   'translation:models': [],
 *   'translation:lookup': [input: { text: string, direction?: string, sentence?: string, source?: Record<string, unknown> | null }],
 *   'translation:translate': [input: { text: string, direction?: string, model?: string, sentence?: string, source?: Record<string, unknown> | null }],
 *   'translation:vocabulary': [],
 *   'translation:vocabulary-save': [input: Record<string, unknown>],
 *   'translation:review': [input: Record<string, unknown>],
 *   'translation:terms': [],
 *   'translation:term-save': [input: Record<string, unknown>],
 *   'translation:term-remove': [id: string],
 *   'capture:open': [],
 *   'capture:shortcut': [],
 *   'capture:shortcut-save': [shortcut: string],
 *   'capture:save': [entry: { text: string, source?: string }],
 *   'capture:list': [options?: Record<string, unknown>],
 *   'capture:idea-create': [item: Record<string, unknown>],
 *   'capture:ideas': [options?: Record<string, unknown>],
 *   'capture:today': [],
 *   'capture:idea-save': [item: Record<string, unknown>],
 *   'capture:close': [],
 *   'state:load': [],
 *   'state:save': [state: Record<string, unknown>],
 *   'startup:probe': [],
 *   'appearance:load': [],
 *   'appearance:save': [value: Record<string, unknown>],
 *   'risk:activity': [],
 *   'risk:preferences': [],
 *   'risk:preferences-save': [value: Record<string, unknown>],
 *   'risk:root': [],
 *   'risk:pick-root': [],
 *   'risk:pick-backup': [],
 *   'risk:clear-backup': [],
 *   'risk:snapshot': [],
 *   'risk:snapshots': [],
 *   'risk:history': [relativePath: string],
 *   'risk:restore-record': [relativePath: string, revision: string],
 *   'risk:restore-snapshot': [],
 *   'risk:migrate': [],
 *   'risk:records': [],
 *   'risk:search': [query: string],
 *   'risk:share': [id: string, relativePath: string],
 *   'risk:privacy': [id: string, value: boolean, relativePath: string],
 *   'risk:review': [options?: Record<string, unknown>],
 *   'risk:mirror': [],
 *   'risk:mirror-status': [],
 *   'risk:reveal-mirror': [],
 *   'risk:reveal-rejected': [],
 *   'risk:snapshot-save': [id: string, content: string],
 *   'risk:snapshot-list': [id: string],
 *   'risk:snapshot-read': [id: string, snapshotId: string],
 *   'inspiration:list': [],
 *   'inspiration:save': [item: Record<string, unknown>],
 *   'inspiration:pick-image': [],
 *   'links:list-organization': [],
 *   'links:bulk-tag': [input: Record<string, unknown>],
 *   'links:rename-tag': [input: Record<string, unknown>],
 *   'links:aliases': [input: Record<string, unknown>],
 *   'links:primary': [input: Record<string, unknown>],
 *   'links:undo': [],
 *   'links:check': [input: Record<string, unknown>],
 *   'workbench:links': [query?: string],
 *   'search:query': [input: Record<string, unknown>],
 *   'search:backlinks': [id: string],
 *   'search:copy-reference': [id: string],
 *   'weekly:get': [input: Record<string, unknown>],
 *   'weekly:current-week': [],
 *   'weekly:week-for-date': [date: string],
 *   'weekly:ideas': [input: Record<string, unknown>],
 *   'weekly:save': [input: Record<string, unknown>],
 *   'weekly:decide': [input: Record<string, unknown>],
 *   'weekly:draft': [input: Record<string, unknown>],
 *   'weekly:template': [input: Record<string, unknown>],
 *   'weekly:reveal-draft': [],
 *   'workbench:save-link': [item: Record<string, unknown>],
 *   'workbench:link-notes': [id: string],
 *   'workbench:folders': [input: { scope: FolderScope, linkId?: string }],
 *   'workbench:create-folder': [input: { scope: FolderScope, linkId?: string, parentPath?: string, name: string }],
 *   'workbench:move-record': [input: { scope: FolderScope, linkId?: string, relativePath: string, destination?: string, expectedContentHash?: string }],
 *   'workbench:get-link-note': [id: string, name: string],
 *   'workbench:save-link-note': [input: Record<string, unknown>],
 *   'workbench:reveal-link-notes': [id: string],
 *   'workbench:copy-link-handoff': [id: string],
 *   'workbench:experiments': [],
 *   'workbench:save-experiment': [item: Record<string, unknown>],
 *   'workbench:plan': [filters?: Record<string, unknown>],
 *   'workbench:mutate-plan': [item: Record<string, unknown>],
 *   'workbench:copy-link': [url: string],
 *   'workbench:open-link': [url: string],
 *   'workbench:notes': [filters?: { kind?: NoteKind, query?: string, fileId?: string }],
 *   'workbench:save-note': [item: SaveNoteInput],
 *   'workbench:files': [],
 *   'workbench:import': [],
 *   'workbench:drop': [paths: string[]],
 *   'workbench:reveal-file': [id: string],
 *   'scene:diagnostics': [id: string],
 *   'folders:list': [],
 *   'folders:pick': [],
 *   'folders:remove': [folder: string],
 *   'library:refresh': [],
 *   'suite:invoke': [operation: string, input?: Record<string, unknown>],
 * }} CommandArgumentMap
 */

/**
 * Promise results mirror the Electron ipcRenderer.invoke boundary. Common
 * DTOs stay structurally typed by their service APIs where available; generic
 * records below mark intentionally opaque service-owned payloads.
 *
 * @typedef {{
 *   'window:ready': Promise<{ maximized: boolean, fullscreen: boolean }>,
 *   'window:control': Promise<void>,
 *   'window:quit-result': Promise<void>,
 *   'suite:open': Promise<boolean>,
 *   'suite:clipboard-invoke': Promise<unknown>,
 *   'suite:clipboard-read-text': Promise<string>,
 *   'suite:clipboard-write-text': Promise<{written:boolean,text:string}>,
 *   'appearance:window-material': Promise<void>,
 *   'prompts:list': Promise<Array<{id:string,title:string,body:string,updatedAt:string}>>,
 *   'prompts:save': Promise<{id:string,title:string,body:string,updatedAt:string}>,
 *   'browser:state': Promise<EventPayloadMap['browser:state']>,
 *   'browser:navigate': Promise<unknown>,
 *   'browser:back': Promise<unknown>,
 *   'browser:forward': Promise<unknown>,
 *   'browser:reload': Promise<unknown>,
 *   'browser:hide': Promise<unknown>,
 *   'browser:bounds': Promise<boolean>,
 *   'browser:open-external': Promise<unknown>,
 *   'articles:capture-clipboard': Promise<unknown>,
 *   'articles:list': Promise<unknown[]>,
 *   'articles:get': Promise<unknown|null>,
 *   'articles:capture': Promise<unknown|null>,
 *   'articles:update': Promise<unknown|null>,
 *   'articles:highlight': Promise<unknown>,
 *   'articles:open-link': Promise<void>,
 *   'articles:delete': Promise<ArticleDeleteResult>,
 *   'articles:annotation-remove': Promise<ArticleAnnotationRemoveResult>,
 *   'articles:translate': Promise<unknown>,
 *   'articles:export': Promise<{ path: string }|null>,
 *   'tags:recent': Promise<string[]>,
 *   'life:list': Promise<unknown[]>,
 *   'life:get': Promise<unknown|null>,
 *   'life:save': Promise<unknown>,
 *   'life:template-save': Promise<unknown>,
 *   'life:append-timeline': Promise<unknown>,
 *   'translation:models': Promise<{ models: { id: string, label: string, available: boolean, directions: string[], reason: string }[], error?: string }>,
 *   'translation:lookup': Promise<unknown>,
 *   'translation:translate': Promise<unknown>,
 *   'translation:vocabulary': Promise<VocabularyListResult>,
 *   'translation:vocabulary-save': Promise<VocabularySaveResult>,
 *   'translation:review': Promise<VocabularyListResult>,
 *   'translation:terms': Promise<VocabularyTermList>,
 *   'translation:term-save': Promise<VocabularyTermList>,
 *   'translation:term-remove': Promise<VocabularyTermList>,
 *   'capture:open': Promise<boolean>,
 *   'capture:shortcut': Promise<unknown>,
 *   'capture:shortcut-save': Promise<unknown>,
 *   'capture:save': Promise<unknown>,
 *   'capture:list': Promise<unknown>,
 *   'capture:idea-create': Promise<unknown>,
 *   'capture:ideas': Promise<unknown>,
 *   'capture:today': Promise<unknown>,
 *   'capture:idea-save': Promise<unknown>,
 *   'capture:close': Promise<boolean>,
 *   'state:load': Promise<WorkbenchSettingsState>,
 *   'state:save': Promise<void>,
 *   'startup:probe': Promise<{ ok: true, dataRoot: string, noteCount: number, linkCount: number, mirror: { changed: number, files: string[], busy: boolean } }|{ ok: false }>,
 *   'appearance:load': Promise<WorkbenchAppearance>,
 *   'appearance:save': Promise<WorkbenchAppearance>,
 *   'risk:activity': Promise<boolean>,
 *   'risk:preferences': Promise<WorkbenchRiskPreferences>,
 *   'risk:preferences-save': Promise<WorkbenchRiskPreferences>,
 *   'risk:root': Promise<{ root: string, warning?: string, portable: boolean, source: string }>,
 *   'risk:pick-root': Promise<{ root: string, warning: string }|null>,
 *   'risk:pick-backup': Promise<WorkbenchRiskPreferences>,
 *   'risk:clear-backup': Promise<WorkbenchRiskPreferences>,
 *   'risk:snapshot': Promise<unknown>,
 *   'risk:snapshots': Promise<Awaited<ReturnType<HistoryService['listSnapshots']>>>,
 *   'risk:history': Promise<Awaited<ReturnType<HistoryService['listRecordHistory']>>>,
 *   'risk:restore-record': Promise<Awaited<ReturnType<HistoryService['restoreRecord']>>>,
 *   'risk:restore-snapshot': Promise<RestoreSnapshotResult|null>,
 *   'risk:migrate': Promise<unknown>,
 *   'risk:records': Promise<unknown[]>,
 *   'risk:search': Promise<unknown>,
 *   'risk:share': Promise<unknown>,
 *   'risk:privacy': Promise<unknown>,
 *   'risk:review': Promise<unknown>,
 *   'risk:mirror': Promise<unknown>,
 *   'risk:mirror-status': Promise<{ busy: boolean, pending: number }>,
 *   'risk:reveal-mirror': Promise<void>,
 *   'risk:reveal-rejected': Promise<void>,
 *   'risk:snapshot-save': Promise<unknown>,
 *   'risk:snapshot-list': Promise<Awaited<ReturnType<LinkSnapshotsService['list']>>>,
 *   'risk:snapshot-read': Promise<Awaited<ReturnType<LinkSnapshotsService['read']>>>,
 *   'inspiration:list': Promise<unknown[]>,
 *   'inspiration:save': Promise<unknown>,
 *   'inspiration:pick-image': Promise<unknown>,
 *   'links:list-organization': Promise<unknown[]>,
 *   'links:bulk-tag': Promise<unknown>,
 *   'links:rename-tag': Promise<unknown>,
 *   'links:aliases': Promise<unknown>,
 *   'links:primary': Promise<unknown>,
 *   'links:undo': Promise<unknown>,
 *   'links:check': Promise<unknown>,
 *   'workbench:links': Promise<WorkbenchLinkList>,
 *   'search:query': Promise<{ results: unknown[], total: number, elapsedMs: number, indexedCount: number }>,
 *   'search:backlinks': Promise<unknown[]>,
 *   'search:copy-reference': Promise<void>,
 *   'weekly:get': Promise<unknown>,
 *   'weekly:current-week': Promise<unknown>,
 *   'weekly:week-for-date': Promise<unknown>,
 *   'weekly:ideas': Promise<unknown>,
 *   'weekly:save': Promise<unknown>,
 *   'weekly:decide': Promise<unknown>,
 *   'weekly:draft': Promise<unknown>,
 *   'weekly:template': Promise<unknown>,
 *   'weekly:reveal-draft': Promise<void>,
 *   'workbench:save-link': Promise<unknown>,
 *   'workbench:link-notes': Promise<Awaited<ReturnType<WorkbenchStore['listLinkNotes']>>>,
 *   'workbench:folders': Promise<string[]>,
 *   'workbench:create-folder': Promise<{ path: string }>,
 *   'workbench:move-record': Promise<{ relativePath: string, id?: string, contentHash: string }>,
 *   'workbench:get-link-note': Promise<WorkbenchLinkNote>,
 *   'workbench:save-link-note': Promise<WorkbenchSavedLinkNote>,
 *   'workbench:reveal-link-notes': Promise<void>,
 *   'workbench:copy-link-handoff': Promise<void>,
 *   'workbench:experiments': Promise<Awaited<ReturnType<ResearchService['listExperiments']>>>,
 *   'workbench:save-experiment': Promise<Awaited<ReturnType<ResearchService['saveExperiment']>>>,
 *   'workbench:plan': Promise<Awaited<ReturnType<ResearchService['getPlan']>>>,
 *   'workbench:mutate-plan': Promise<Awaited<ReturnType<ResearchService['mutatePlan']>>>,
 *   'workbench:copy-link': Promise<void>,
 *   'workbench:open-link': Promise<void>,
 *   'workbench:notes': Promise<WorkbenchNoteList>,
 *   'workbench:save-note': Promise<WorkbenchSavedNote>,
 *   'workbench:files': Promise<WorkbenchFileList>,
 *   'workbench:import': Promise<WorkbenchImportResult|null>,
 *   'workbench:drop': Promise<WorkbenchImportResult|null>,
 *   'workbench:reveal-file': Promise<void>,
 *   'scene:diagnostics': Promise<unknown>,
 *   'folders:list': Promise<{ folder: string, available: boolean, reason?: string }[]>,
 *   'folders:pick': Promise<boolean>,
 *   'folders:remove': Promise<void>,
 *   'library:refresh': Promise<void>,
 *   'suite:invoke': Promise<unknown>,
 * }} CommandResultMap
 */

/**
 * Service-derived shapes keep the note and file IPC results tied to the
 * storage implementation instead of maintaining duplicate DTO declarations.
 * @typedef {'note'|'daily'|'weekly'|'memo'} NoteKind
 * @typedef {'notes'|'daily'|'weekly'|'memos'|'links'|'link-notes'} FolderScope
 * @typedef {{ kind: NoteKind, id?: string, date?: string, title?: string, body?: string,
 *   tags?: string[], fileId?: string | null, page?: number | null, expectedContentHash?: string,
 *   path?: string, folderPath?: string }} SaveNoteInput
 * @typedef {ReturnType<typeof import('../workbench-store.mjs').createWorkbenchStore>} WorkbenchStore
 * @typedef {Awaited<ReturnType<WorkbenchStore['listNotes']>>} WorkbenchNoteList
 * @typedef {Awaited<ReturnType<WorkbenchStore['listLinks']>>} WorkbenchLinkList
 * @typedef {Awaited<ReturnType<WorkbenchStore['getLinkNote']>>} WorkbenchLinkNote
 * @typedef {Awaited<ReturnType<WorkbenchStore['saveNote']>>} WorkbenchSavedNote
 * @typedef {Awaited<ReturnType<WorkbenchStore['saveLinkNote']>>} WorkbenchSavedLinkNote
 * @typedef {Awaited<ReturnType<WorkbenchStore['listFiles']>>} WorkbenchFileList
 * @typedef {Awaited<ReturnType<WorkbenchStore['importFiles']>>} WorkbenchImportResult
 * @typedef {ReturnType<typeof import('../desktop_vocabulary.mjs').createDesktopVocabulary>} VocabularyService
 * @typedef {Awaited<ReturnType<VocabularyService['listVocabulary']>>} VocabularyListResult
 * @typedef {Awaited<ReturnType<VocabularyService['listTerms']>>} VocabularyTermList
 * @typedef {ReturnType<typeof import('../desktop_history.mjs').createDesktopHistory>} HistoryService
 * @typedef {Awaited<ReturnType<HistoryService['restoreSnapshot']>>} RestoreSnapshotResult
 * @typedef {ReturnType<typeof import('../desktop_articles.mjs').openArticleStore>} ArticleStorePromise
 * @typedef {Awaited<ArticleStorePromise>} ArticleStore
 * @typedef {Awaited<ReturnType<ArticleStore['delete']>>} ArticleDeleteResult
 * @typedef {Awaited<ReturnType<ArticleStore['removeAnnotation']>>} ArticleAnnotationRemoveResult
 * @typedef {ReturnType<typeof import('../desktop_library_tools.mjs').createLinkSnapshots>} LinkSnapshotsService
 * @typedef {ReturnType<typeof import('../research-store.mjs').createResearchStore>} ResearchService
 * @typedef {Awaited<ReturnType<VocabularyService['saveVocabulary']>>} VocabularySaveResult
 * @typedef {ReturnType<typeof import('../desktop_settings.mjs').openDesktopSettings>} WorkbenchSettings
 * @typedef {ReturnType<WorkbenchSettings['getState']>} WorkbenchSettingsState
 * @typedef {ReturnType<WorkbenchSettings['getAppearance']>} WorkbenchAppearance
 * @typedef {ReturnType<WorkbenchSettings['getRiskPreferences']>} WorkbenchRiskPreferences
 */

/**
 * Suite operations all cross the same `suite:invoke(operation, input)` IPC.
 * These maps document the per-operation payload at that second argument.
 *
 * @typedef {{
 *   'window.hide': [],
 *   'window.control': [input: {command:'minimize'|'maximize'}],
 *   'history.search': [input: { query?: string, type?: string, boardId?: string, limit?: number, offset?: number }],
 *   'history.detail': [input: { id: string }],
 *   'history.copy': [input: { id: string }],
 *   'history.copy-batch': [input: { ids: string[] }],
 *   'history.paste': [input: { id: string, plainText?: boolean }],
 *   'history.action': [input: { id: string, action: string }],
 *   'history.delete': [input: { id: string }],
 *   'history.clear': [],
 *   'boards.list': [],
 *   'boards.create': [input: { name: string }],
 *   'boards.rename': [input: { id: string, name: string }],
 *   'boards.delete': [input: { id: string }],
 *   'boards.set': [input: { boardId: string, itemId: string, pinned: boolean }],
 *   'stack.state': [],
 *   'stack.set': [input: { enabled: boolean }],
 *   'stack.paste': [],
 *   'settings.get': [],
 *   'settings.update': [input: Record<string, unknown>],
 *   'launcher.search': [input: { query?: string }],
 *   'launcher.run': [input: { id: string }],
 *   'selection.state': [],
 *   'selection.action': [input: { action: string, text?: string, selectionToken?: string }],
 *   'pin.state': [],
 *   'pin.opacity': [input: { opacity: number }],
 *   'pin.resize': [input: { direction: 'grow'|'shrink' }],
 *   'pin.save': [],
 * }} SuiteOperationArgumentMap
 *
 * @typedef {{
 *   'window.hide': Promise<boolean>,
 *   'window.control': Promise<boolean>,
 *   'history.search': Promise<unknown[]>,
 *   'history.detail': Promise<unknown>,
 *   'history.copy': Promise<unknown>,
 *   'history.copy-batch': Promise<unknown>,
 *   'history.paste': Promise<unknown>,
 *   'history.action': Promise<unknown>,
 *   'history.delete': Promise<boolean>,
 *   'history.clear': Promise<unknown>,
 *   'boards.list': Promise<unknown[]>,
 *   'boards.create': Promise<unknown>,
 *   'boards.rename': Promise<unknown>,
 *   'boards.delete': Promise<unknown>,
 *   'boards.set': Promise<unknown>,
 *   'stack.state': Promise<unknown>,
 *   'stack.set': Promise<unknown>,
 *   'stack.paste': Promise<unknown>,
 *   'settings.get': Promise<unknown>,
 *   'settings.update': Promise<unknown>,
 *   'launcher.search': Promise<unknown[]>,
 *   'launcher.run': Promise<unknown>,
 *   'selection.state': Promise<unknown>,
 *   'selection.action': Promise<unknown>,
 *   'pin.state': Promise<unknown>,
 *   'pin.opacity': Promise<boolean>,
 *   'pin.resize': Promise<boolean>,
 *   'pin.save': Promise<boolean>,
 * }} SuiteOperationResultMap
 */

/**
 * Results from the Markdown storage service are inferred from its concrete
 * implementation. The remaining business services deliberately stay opaque
 * until their modules publish stable JSDoc DTOs.
 */

export const IPC_PREFIX = 'stilltime:';

/** @type {[keyof CommandArgumentMap, boolean, boolean?, boolean?][]} */
const commandRows = [
  ['window:ready',false], ['window:control',false], ['window:quit-result',false],
  ['suite:open',false],
  ['suite:clipboard-invoke',false], ['suite:clipboard-read-text',false], ['suite:clipboard-write-text',false],
  ['appearance:window-material',false],
  ['prompts:list',false], ['prompts:save',true],
  ['browser:state',false], ['browser:navigate',false], ['browser:back',false], ['browser:forward',false],
  ['browser:reload',false], ['browser:hide',false], ['browser:bounds',false], ['browser:open-external',false],
  ['articles:capture-clipboard',false], ['articles:list',false], ['articles:get',false],
  ['articles:capture',false], ['articles:update',true], ['articles:highlight',true],
  ['articles:open-link',false], ['articles:delete',true], ['articles:annotation-remove',true],
  ['articles:translate',false], ['articles:export',false],
  ['tags:recent',false],
  ['life:list',false], ['life:get',false], ['life:save',true],
  ['life:template-save',true], ['life:append-timeline',true],
  ['translation:models',false], ['translation:lookup',false], ['translation:translate',false],
  ['translation:vocabulary',false], ['translation:vocabulary-save',true], ['translation:review',true],
  ['translation:terms',false], ['translation:term-save',true], ['translation:term-remove',true],
  ['capture:open',false,true], ['capture:shortcut',false,true], ['capture:shortcut-save',true,true],
  ['capture:save',true,true,true], ['capture:list',false,true], ['capture:idea-create',true,true],
  ['capture:ideas',false,true], ['capture:today',false,true], ['capture:idea-save',true,true], ['capture:close',false,true,true],
  ['state:load',false], ['state:save',false], ['startup:probe',false], ['appearance:load',false], ['appearance:save',false],
  ['risk:activity',false], ['risk:preferences',false], ['risk:preferences-save',true], ['risk:root',false],
  ['risk:pick-root',false], ['risk:pick-backup',true], ['risk:clear-backup',true], ['risk:snapshot',true],
  ['risk:snapshots',false], ['risk:history',true], ['risk:restore-record',true], ['risk:restore-snapshot',true],
  ['risk:migrate',true], ['risk:records',false], ['risk:search',false], ['risk:share',true], ['risk:privacy',true],
  ['risk:review',true], ['risk:mirror',true], ['risk:mirror-status',true], ['risk:reveal-mirror',true],
  ['risk:reveal-rejected',true], ['risk:snapshot-save',true], ['risk:snapshot-list',false], ['risk:snapshot-read',false],
  ['inspiration:list',false], ['inspiration:save',true], ['inspiration:pick-image',true],
  ['links:list-organization',false], ['links:bulk-tag',true], ['links:rename-tag',true], ['links:aliases',true],
  ['links:primary',true], ['links:undo',true], ['links:check',false],
  ['workbench:links',false], ['search:query',false], ['search:backlinks',false], ['search:copy-reference',true],
  ['weekly:get',false], ['weekly:current-week',false], ['weekly:week-for-date',false], ['weekly:ideas',false],
  ['weekly:save',true], ['weekly:decide',true], ['weekly:draft',false], ['weekly:template',true], ['weekly:reveal-draft',true],
  ['workbench:save-link',true], ['workbench:link-notes',false], ['workbench:folders',false], ['workbench:create-folder',true], ['workbench:move-record',true], ['workbench:get-link-note',false],
  ['workbench:save-link-note',true], ['workbench:reveal-link-notes',false], ['workbench:copy-link-handoff',true],
  ['workbench:experiments',false], ['workbench:save-experiment',true], ['workbench:plan',false],
  ['workbench:mutate-plan',true], ['workbench:copy-link',false], ['workbench:open-link',false],
  ['workbench:notes',false], ['workbench:save-note',true], ['workbench:files',false], ['workbench:import',false],
  ['workbench:drop',false], ['workbench:reveal-file',false], ['scene:diagnostics',false],
  ['folders:list',false], ['folders:pick',false], ['folders:remove',false], ['library:refresh',false],
  ['suite:invoke',false],
];

const preloadMethodRows = `
window:ready|window.ready
window:control|window.control
window:quit-result|window.quitResult
articles:list|articles.list
articles:get|articles.get
articles:capture|articles.capture
articles:capture-clipboard|articles.captureClipboard
articles:update|articles.update
articles:highlight|articles.highlight
articles:open-link|articles.openLink
articles:delete|articles.delete
articles:annotation-remove|articles.removeAnnotation
articles:translate|articles.translate
articles:export|articles.export
suite:open|desktopSuite.open
suite:clipboard-invoke|desktopSuite.invokeClipboard
suite:clipboard-read-text|desktopSuite.readText
suite:clipboard-write-text|desktopSuite.writeText
prompts:list|prompts.list
prompts:save|prompts.save
browser:state|articles.browser.state
browser:navigate|articles.browser.navigate
browser:back|articles.browser.back
browser:forward|articles.browser.forward
browser:reload|articles.browser.reload
browser:hide|articles.browser.hide
browser:bounds|articles.browser.setBounds
browser:open-external|articles.browser.openExternal
tags:recent|recentTags.list
translation:models|translation.availableModels
translation:lookup|translation.lookup
translation:translate|translation.translate
translation:vocabulary|translation.listVocabulary
translation:vocabulary-save|translation.saveVocabulary
translation:review|translation.reviewVocabulary
translation:terms|translation.listTerms
translation:term-save|translation.saveTerm
translation:term-remove|translation.removeTerm
life:list|life.list
life:get|life.get
life:save|life.save
life:template-save|life.saveTemplate
life:append-timeline|life.appendTimeline
inspiration:list|inspiration.list
inspiration:save|inspiration.save
inspiration:pick-image|inspiration.pickImage
search:query|search.query
search:backlinks|search.backlinks
search:copy-reference|search.copyReference
weekly:current-week|weeklyReview.currentWeek
weekly:week-for-date|weeklyReview.weekForDate
weekly:get|weeklyReview.getReview
weekly:ideas|weeklyReview.listWeekIdeas
weekly:save|weeklyReview.saveReview
weekly:decide|weeklyReview.decideIdeas
weekly:draft|weeklyReview.readDraft
weekly:template|weeklyReview.writeDraftTemplate
weekly:reveal-draft|weeklyReview.revealDraft
links:list-organization|links.listLinks
links:bulk-tag|links.bulkTag
links:rename-tag|links.renameTag
links:aliases|links.saveTagAliases
links:primary|links.setPrimary
links:undo|links.undo
links:check|links.check
capture:open|capture.openQuickCapture
capture:shortcut|capture.captureShortcut
capture:shortcut-save|capture.setCaptureShortcut
capture:save|capture.save,capturePreload.save
capture:list|capture.listCaptures
capture:idea-create|capture.createIdea
capture:ideas|capture.listIdeas
capture:today|capture.today
capture:idea-save|capture.saveIdea
capture:close|capturePreload.close
state:load|loadState
state:save|saveState
startup:probe|startupProbe
appearance:load|loadAppearance
appearance:save|saveAppearance
appearance:window-material|syncWindowMaterial
scene:diagnostics|inspectScene
folders:list|listFolders
folders:pick|pickFolder
folders:remove|removeFolder
library:refresh|refreshLibrary
risk:activity|risk.getRenderActivity
risk:preferences|risk.preferences
risk:preferences-save|risk.savePreferences
risk:root|risk.dataRoot
risk:pick-root|risk.pickDataRoot
risk:pick-backup|risk.pickBackup
risk:clear-backup|risk.clearBackup
risk:snapshot|risk.snapshot
risk:snapshots|risk.snapshots
risk:history|risk.recordHistory
risk:restore-record|risk.restoreRecord
risk:restore-snapshot|risk.restoreSnapshot
risk:migrate|risk.migrate
risk:records|risk.records
risk:search|risk.search
risk:share|risk.share
risk:privacy|risk.setPrivate
risk:review|risk.review
risk:mirror|risk.mirror
risk:mirror-status|risk.mirrorStatus
risk:reveal-mirror|risk.revealMirror
risk:reveal-rejected|risk.revealRejected
risk:snapshot-save|risk.saveLinkSnapshot
risk:snapshot-list|risk.listLinkSnapshots
risk:snapshot-read|risk.readLinkSnapshot
workbench:links|workbench.listLinks
workbench:save-link|workbench.saveLink
workbench:link-notes|workbench.listLinkNotes
workbench:folders|workbench.listFolders
workbench:create-folder|workbench.createFolder
workbench:move-record|workbench.moveRecord
workbench:get-link-note|workbench.getLinkNote
workbench:save-link-note|workbench.saveLinkNote
workbench:reveal-link-notes|workbench.revealLinkNotes
workbench:copy-link-handoff|workbench.copyLinkHandoff
workbench:experiments|workbench.listExperiments
workbench:save-experiment|workbench.saveExperiment
workbench:plan|workbench.getPlan
workbench:mutate-plan|workbench.mutatePlan
workbench:copy-link|workbench.copyLink
workbench:open-link|workbench.openLink
workbench:notes|workbench.listNotes
workbench:save-note|workbench.saveNote
workbench:files|workbench.listFiles
workbench:import|workbench.importFiles
workbench:drop|workbench.dropFiles
workbench:reveal-file|workbench.revealFile
suite:invoke|desktopSuite.invoke
`.trim().split('\n').map(line => {
  const [key, methods] = line.split('|');
  return [key, methods.split(',')];
});
const preloadMethods = Object.fromEntries(preloadMethodRows);

/** @type {Readonly<Record<string, Readonly<CommandContract>>>} */
export const commands = Object.freeze(Object.fromEntries(commandRows.map(([key, write, capture = key.startsWith('capture:'), capturePopup = false]) => [
  key,
  Object.freeze({
    channel: IPC_PREFIX + key,
    write,
    capture,
    capturePopup,
    methods: preloadMethods[key] ?? [],
  }),
])));

/** @type {[keyof EventPayloadMap, string[], string[]][]} */
const eventRows = [
  ['window:state',['stilltimeDesktop.window.onState'],['main']],
  ['window:quit-request',['stilltimeDesktop.window.onQuitRequest'],['main']],
  ['articles:changed',['stilltimeDesktop.articles.onChanged'],['main']],
  ['articles:clipboard-link',['stilltimeDesktop.articles.onClipboardLink'],['main']],
  ['articles:clipboard-result',['stilltimeDesktop.articles.onClipboardResult'],['main']],
  ['suite:workbench-action',['stilltimeDesktop.desktopSuite.onWorkbenchAction'],['main']],
  ['index:changed',['stilltimeDesktop.onIndexChanged'],['main']],
  ['capture:saved',['stilltimeDesktop.capture.onCaptureSaved'],['main','capture']],
  ['capture:appearance',['stilltimeCapture.onAppearance'],['capture']],
  ['capture:source',['stilltimeCapture.onSource'],['capture']],
  ['risk:activity',['stilltimeDesktop.risk.onRenderActivity'],['main']],
  ['risk:backup-error',['stilltimeDesktop.risk.onBackupError'],['main']],
  ['risk:mirror-changed',['stilltimeDesktop.risk.onMirrorChanged'],['main']],
  ['suite:changed',['desktopSuite.onChanged'],['suite']],
  ['suite:clipboard-changed',['stilltimeDesktop.desktopSuite.onChanged'],['main']],
  ['browser:state',['stilltimeDesktop.articles.browser.onState'],['main']],
];

/** @type {Readonly<Record<string, Readonly<EventContract>>>} */
export const events = Object.freeze(Object.fromEntries(eventRows.map(([key, methods, recipients]) => [
  key, Object.freeze({ channel: IPC_PREFIX + key, methods, recipients }),
])));

const suiteRows = {
  main: ['history.search','history.detail','history.copy','history.copy-batch','history.action','history.delete','history.clear',
    'boards.list','boards.create','boards.rename','boards.delete','boards.set','stack.state','stack.set','settings.get','settings.update'],
  clipboard: ['window.hide','window.control','history.search','history.detail','history.paste','history.action','history.delete','history.clear',
    'boards.list','boards.create','boards.rename','boards.delete','boards.set','stack.state','stack.set','stack.paste',
    'settings.get','settings.update'],
  launcher: ['window.hide','launcher.search','launcher.run'],
  selection: ['window.hide','selection.state','selection.action'],
  pin: ['window.hide','pin.state','pin.resize','pin.opacity','pin.save'],
};
/** @type {Record<string, SuiteOperationContract>} */
const suiteOperationMap = {};
for (const [role, operations] of Object.entries(suiteRows)) {
  for (const operation of operations) {
    const item = suiteOperationMap[operation] ??= { roles: [], write: [
      'history.copy','history.copy-batch','history.paste','history.delete','history.clear','boards.create','boards.rename','boards.delete','boards.set',
      'stack.set','stack.paste','settings.update','launcher.run',
    ].includes(operation) };
    item.roles.push(role);
  }
}
export const suiteOperations = Object.freeze(Object.fromEntries(Object.entries(suiteOperationMap).map(([key, value]) => [
  key, Object.freeze({ ...value, roles: Object.freeze(value.roles) }),
])));

