const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('stilltimeDesktop', {
  syncWindowMaterial: value => ipcRenderer.invoke(channels["appearance:window-material"], value),
  window: {
    ready: () => ipcRenderer.invoke(channels["window:ready"]),
    control: command => ipcRenderer.invoke(channels["window:control"], command),
    quitResult: (id, close) => ipcRenderer.invoke(channels["window:quit-result"], id, close),
    onState: listener => { ipcRenderer.on(channels["window:state"], (_event, state) => listener(state)); },
    onQuitRequest: listener => { ipcRenderer.on(channels["window:quit-request"], (_event, id) => listener(id)); },
  },
  articles: {
    browser: {
      state: () => ipcRenderer.invoke(channels["browser:state"]),
      navigate: url => ipcRenderer.invoke(channels["browser:navigate"], url),
      back: () => ipcRenderer.invoke(channels["browser:back"]),
      forward: () => ipcRenderer.invoke(channels["browser:forward"]),
      reload: () => ipcRenderer.invoke(channels["browser:reload"]),
      hide: () => ipcRenderer.invoke(channels["browser:hide"]),
      setBounds: bounds => ipcRenderer.invoke(channels["browser:bounds"], bounds),
      openExternal: () => ipcRenderer.invoke(channels["browser:open-external"]),
      onState(listener) {
        const wrapped = (_event, state) => listener(state);
        ipcRenderer.on(channels["browser:state"], wrapped);
        return () => ipcRenderer.removeListener(channels["browser:state"], wrapped);
      },
    },
    list: input => ipcRenderer.invoke(channels["articles:list"], input),
    get: input => ipcRenderer.invoke(channels["articles:get"], input),
    capture: input => ipcRenderer.invoke(channels["articles:capture"], input),
    captureClipboard: input => ipcRenderer.invoke(channels["articles:capture-clipboard"], input),
    update: input => ipcRenderer.invoke(channels["articles:update"], input),
    highlight: input => ipcRenderer.invoke(channels["articles:highlight"], input),
    openLink: input => ipcRenderer.invoke(channels["articles:open-link"], input),
    delete: input => ipcRenderer.invoke(channels["articles:delete"], input),
    removeAnnotation: input => ipcRenderer.invoke(channels["articles:annotation-remove"], input),
    translate: input => ipcRenderer.invoke(channels["articles:translate"], input),
    export: input => ipcRenderer.invoke(channels["articles:export"], input),
    onChanged: listener => ipcRenderer.on(channels["articles:changed"], (_event, result) => listener(result)),
    onClipboardLink: listener => ipcRenderer.on(channels["articles:clipboard-link"], (_event, result) => listener(result)),
    onClipboardResult: listener => ipcRenderer.on(channels["articles:clipboard-result"], (_event, result) => listener(result)),
  },
  desktopSuite: {
    open: () => ipcRenderer.invoke(channels["suite:open"]),
    invokeClipboard: (operation, input) => ipcRenderer.invoke(channels["suite:clipboard-invoke"], operation, input),
    readText: () => ipcRenderer.invoke(channels["suite:clipboard-read-text"]),
    writeText: value => ipcRenderer.invoke(channels["suite:clipboard-write-text"], value),
    onChanged(listener) {
      const wrapped = (_event, value) => listener(value);
      ipcRenderer.on(channels["suite:clipboard-changed"], wrapped);
      return () => ipcRenderer.removeListener(channels["suite:clipboard-changed"], wrapped);
    },
    onWorkbenchAction(listener) {
      if (typeof listener !== 'function') return;
      const wrapped = (_event, action) => listener(action);
      ipcRenderer.on(channels["suite:workbench-action"], wrapped);
      return () => ipcRenderer.removeListener(channels["suite:workbench-action"], wrapped);
    },
  },
  prompts: {
    list: () => ipcRenderer.invoke(channels["prompts:list"]),
    save: input => ipcRenderer.invoke(channels["prompts:save"], input),
  },
  recentTags: { list: () => ipcRenderer.invoke(channels["tags:recent"]) },
  translation: {
    availableModels: () => ipcRenderer.invoke(channels["translation:models"]),
    lookup: input => ipcRenderer.invoke(channels["translation:lookup"], input),
    translate: input => ipcRenderer.invoke(channels["translation:translate"], input),
    listVocabulary: () => ipcRenderer.invoke(channels["translation:vocabulary"]),
    saveVocabulary: input => ipcRenderer.invoke(channels["translation:vocabulary-save"], input),
    reviewVocabulary: input => ipcRenderer.invoke(channels["translation:review"], input),
    listTerms: () => ipcRenderer.invoke(channels["translation:terms"]),
    saveTerm: input => ipcRenderer.invoke(channels["translation:term-save"], input),
    removeTerm: id => ipcRenderer.invoke(channels["translation:term-remove"], id),
  },
  life: {
    list: input => ipcRenderer.invoke(channels["life:list"], input),
    get: input => ipcRenderer.invoke(channels["life:get"], input),
    save: input => ipcRenderer.invoke(channels["life:save"], input),
    saveTemplate: input => ipcRenderer.invoke(channels["life:template-save"], input),
    appendTimeline: input => ipcRenderer.invoke(channels["life:append-timeline"], input),
  },
  onIndexChanged: listener => {
    const handle = (_event, categories) => listener(categories);
    ipcRenderer.on(channels["index:changed"], handle);
    return () => ipcRenderer.removeListener(channels["index:changed"], handle);
  },
  inspiration: {
    list: () => ipcRenderer.invoke(channels["inspiration:list"]),
    save: item => ipcRenderer.invoke(channels["inspiration:save"], item),
    pickImage: () => ipcRenderer.invoke(channels["inspiration:pick-image"]),
  },
  search: {
    query: input => ipcRenderer.invoke(channels["search:query"], input),
    backlinks: id => ipcRenderer.invoke(channels["search:backlinks"], id),
    copyReference: id => ipcRenderer.invoke(channels["search:copy-reference"], id),
  },
  weeklyReview: {
    currentWeek: () => ipcRenderer.invoke(channels["weekly:current-week"]),
    weekForDate: date => ipcRenderer.invoke(channels["weekly:week-for-date"], date),
    getReview: input => ipcRenderer.invoke(channels["weekly:get"], input),
    listWeekIdeas: input => ipcRenderer.invoke(channels["weekly:ideas"], input),
    saveReview: input => ipcRenderer.invoke(channels["weekly:save"], input),
    decideIdeas: input => ipcRenderer.invoke(channels["weekly:decide"], input),
    readDraft: input => ipcRenderer.invoke(channels["weekly:draft"], input),
    writeDraftTemplate: input => ipcRenderer.invoke(channels["weekly:template"], input),
    revealDraft: () => ipcRenderer.invoke(channels["weekly:reveal-draft"]),
  },
  links: {
    listLinks: () => ipcRenderer.invoke(channels["links:list-organization"]),
    bulkTag: input => ipcRenderer.invoke(channels["links:bulk-tag"], input),
    renameTag: input => ipcRenderer.invoke(channels["links:rename-tag"], input),
    saveTagAliases: input => ipcRenderer.invoke(channels["links:aliases"], input),
    setPrimary: input => ipcRenderer.invoke(channels["links:primary"], input),
    undo: () => ipcRenderer.invoke(channels["links:undo"]),
    check: input => ipcRenderer.invoke(channels["links:check"], input),
  },
  capture: {
    openQuickCapture: () => ipcRenderer.invoke(channels["capture:open"]),
    captureShortcut: () => ipcRenderer.invoke(channels["capture:shortcut"]),
    setCaptureShortcut: shortcut => ipcRenderer.invoke(channels["capture:shortcut-save"], shortcut),
    save: entry => ipcRenderer.invoke(channels["capture:save"], entry),
    listCaptures: options => ipcRenderer.invoke(channels["capture:list"], options),
    createIdea: item => ipcRenderer.invoke(channels["capture:idea-create"], item),
    listIdeas: options => ipcRenderer.invoke(channels["capture:ideas"], options),
    today: () => ipcRenderer.invoke(channels["capture:today"]),
    saveIdea: item => ipcRenderer.invoke(channels["capture:idea-save"], item),
    onCaptureSaved: listener => {
      const handle = (_event, item) => listener(item);
      ipcRenderer.on(channels["capture:saved"], handle);
      return () => ipcRenderer.removeListener(channels["capture:saved"], handle);
    },
  },
  loadState: () => ipcRenderer.invoke(channels["state:load"]),
  saveState: state => ipcRenderer.invoke(channels["state:save"], state),
  startupProbe: () => ipcRenderer.invoke(channels["startup:probe"]),
  loadAppearance: () => ipcRenderer.invoke(channels["appearance:load"]),
  saveAppearance: value => ipcRenderer.invoke(channels["appearance:save"], value),
  inspectScene: id => ipcRenderer.invoke(channels["scene:diagnostics"], id),
  listFolders: () => ipcRenderer.invoke(channels["folders:list"]),
  pickFolder: () => ipcRenderer.invoke(channels["folders:pick"]),
  removeFolder: folder => ipcRenderer.invoke(channels["folders:remove"], folder),
  refreshLibrary: () => ipcRenderer.invoke(channels["library:refresh"]),
  risk: {
    getRenderActivity: () => ipcRenderer.invoke(channels["risk:activity"]),
    onRenderActivity: listener => {
      const handle = (_event, value) => listener(value);
      ipcRenderer.on(channels["risk:activity"], handle);
      return () => ipcRenderer.removeListener(channels["risk:activity"], handle);
    },
    onBackupError: listener => {
      const handle = (_event, message) => listener(message);
      ipcRenderer.on(channels["risk:backup-error"], handle);
      return () => ipcRenderer.removeListener(channels["risk:backup-error"], handle);
    },
    onMirrorChanged: listener => {
      const handle = (_event, value) => listener(value);
      ipcRenderer.on(channels["risk:mirror-changed"], handle);
      return () => ipcRenderer.removeListener(channels["risk:mirror-changed"], handle);
    },
    preferences: () => ipcRenderer.invoke(channels["risk:preferences"]),
    savePreferences: value => ipcRenderer.invoke(channels["risk:preferences-save"], value),
    dataRoot: () => ipcRenderer.invoke(channels["risk:root"]),
    pickDataRoot: () => ipcRenderer.invoke(channels["risk:pick-root"]),
    pickBackup: () => ipcRenderer.invoke(channels["risk:pick-backup"]),
    clearBackup: () => ipcRenderer.invoke(channels["risk:clear-backup"]),
    snapshot: () => ipcRenderer.invoke(channels["risk:snapshot"]),
    snapshots: () => ipcRenderer.invoke(channels["risk:snapshots"]),
    restoreSnapshot: () => ipcRenderer.invoke(channels["risk:restore-snapshot"]),
    recordHistory: relativePath => ipcRenderer.invoke(channels["risk:history"], relativePath),
    restoreRecord: (relativePath, revision) => ipcRenderer.invoke(channels["risk:restore-record"], relativePath, revision),
    migrate: () => ipcRenderer.invoke(channels["risk:migrate"]),
    records: () => ipcRenderer.invoke(channels["risk:records"]),
    search: value => ipcRenderer.invoke(channels["risk:search"], value),
    share: (id, relativePath) => ipcRenderer.invoke(channels["risk:share"], id, relativePath),
    setPrivate: (id, value, relativePath) => ipcRenderer.invoke(channels["risk:privacy"], id, value, relativePath),
    review: options => ipcRenderer.invoke(channels["risk:review"], options),
    mirror: () => ipcRenderer.invoke(channels["risk:mirror"]),
    mirrorStatus: () => ipcRenderer.invoke(channels["risk:mirror-status"]),
    revealMirror: () => ipcRenderer.invoke(channels["risk:reveal-mirror"]),
    revealRejected: () => ipcRenderer.invoke(channels["risk:reveal-rejected"]),
    saveLinkSnapshot: (id, content) => ipcRenderer.invoke(channels["risk:snapshot-save"], id, content),
    listLinkSnapshots: id => ipcRenderer.invoke(channels["risk:snapshot-list"], id),
    readLinkSnapshot: (id, snapshotId) => ipcRenderer.invoke(channels["risk:snapshot-read"], id, snapshotId),
  },
  workbench: {
    listLinks: query => ipcRenderer.invoke(channels["workbench:links"], query),
    saveLink: item => ipcRenderer.invoke(channels["workbench:save-link"], item),
    listLinkNotes: id => ipcRenderer.invoke(channels["workbench:link-notes"], id),
    listFolders: input => ipcRenderer.invoke(channels["workbench:folders"], input),
    createFolder: input => ipcRenderer.invoke(channels["workbench:create-folder"], input),
    moveRecord: input => ipcRenderer.invoke(channels["workbench:move-record"], input),
    getLinkNote: (id, name) => ipcRenderer.invoke(channels["workbench:get-link-note"], id, name),
    saveLinkNote: input => ipcRenderer.invoke(channels["workbench:save-link-note"], input),
    revealLinkNotes: id => ipcRenderer.invoke(channels["workbench:reveal-link-notes"], id),
    copyLinkHandoff: id => ipcRenderer.invoke(channels["workbench:copy-link-handoff"], id),
    listExperiments: () => ipcRenderer.invoke(channels["workbench:experiments"]),
    saveExperiment: item => ipcRenderer.invoke(channels["workbench:save-experiment"], item),
    getPlan: filters => ipcRenderer.invoke(channels["workbench:plan"], filters),
    mutatePlan: item => ipcRenderer.invoke(channels["workbench:mutate-plan"], item),
    copyLink: url => ipcRenderer.invoke(channels["workbench:copy-link"], url),
    openLink: url => ipcRenderer.invoke(channels["workbench:open-link"], url),
    listNotes: filters => ipcRenderer.invoke(channels["workbench:notes"], filters),
    saveNote: item => ipcRenderer.invoke(channels["workbench:save-note"], item),
    listFiles: () => ipcRenderer.invoke(channels["workbench:files"]),
    importFiles: () => ipcRenderer.invoke(channels["workbench:import"]),
    dropFiles: files => ipcRenderer.invoke(channels["workbench:drop"], files.map(file => webUtils.getPathForFile(file)).filter(Boolean)),
    revealFile: id => ipcRenderer.invoke(channels["workbench:reveal-file"], id),
  },
});
