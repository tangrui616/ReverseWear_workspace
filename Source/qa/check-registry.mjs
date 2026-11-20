const electron = (id, label, success, module, exportName, args, options = {}) => ({
  id, label, kind: 'electron', success, timeoutSeconds: 150, isolated: true,
  page: 'workbench', module, exportName, args, steps: [{ module, exportName, args }], cleanup: 'close-window', flags: [], ...options,
});

export const electronChecks = [
  electron('appearance', '外观', 'APPEARANCE_VERIFY_OK', './Appearance_Check_CodexV9.mjs', 'runAppearanceCheck', ['win', 'settings'], { flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('workbench', '工作台', 'WORKBENCH_VERIFY_OK', './Workbench_Check_CodexV7.mjs', 'runWorkbenchCheck', ['win', 'workbench']),
  electron('public-core', '无可选资源的工作台', 'PUBLIC_CORE_VERIFY_OK', './Public_Core_Check_CodexV1.mjs', 'runPublicCoreCheck', ['win', 'publicCoreContext'], { path: '/?verify=1&startup=1', cleanup: 'exit' }),
  electron('research', '研究', 'RESEARCH_VERIFY_OK', './Research_Check_CodexV8.mjs', 'runResearchCheck', ['win', 'workbench', 'research']),
  electron('ouroboros', '衔尾蛇', 'OUROBOROS_VERIFY_OK', './Ouroboros_Check_CodexV9.0.1.mjs', 'runOuroborosCheck', ['win'], { flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('risk', '数据风险', 'RISK_VERIFY_OK', './Risk_Check_CodexV9.1.mjs', 'runRiskCheck', ['win'], { fixture: 'wallpaper', flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('organize', '文件整理', 'ORGANIZATION_VERIFY_OK', './Organization_Check_CodexV10.1.mjs', 'runOrganizationCheck', ['win', 'organizationContext']),
  electron('focus', '专注', '专注计时、背景切换与声音开关验收完成', './Focus_Check_CodexV15.mjs', 'runFocusCheck', ['win', 'settings', 'fixtureRoot'], { page: 'focus', timeoutSeconds: 300, cleanup: 'exit', flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('v17', '工作台综合兼容验收', 'WORKBENCH_V17_VERIFY_OK', './Workbench_V17_Check.mjs', 'runV17Check', ['win', 'v17Context'], { timeoutSeconds: 300, cleanup: 'exit', translationAssets: process.env.REVERSEWEAR_TRANSLATION_ASSETS, requires: process.env.REVERSEWEAR_TRANSLATION_ASSETS ? [process.env.REVERSEWEAR_TRANSLATION_ASSETS] : ['设置 REVERSEWEAR_TRANSLATION_ASSETS'], flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('suite-v18', '桌面套件与历史文章存储兼容', 'SUITE_V18_VERIFY_OK', './DesktopSuite_Check_CodexV18.mjs', 'runDesktopSuiteCheck', ['win', 'suiteContext'], { timeoutSeconds: 300, cleanup: 'close-suite-articles', steps: [
    { module: './DesktopSuite_Check_CodexV18.mjs', exportName: 'runDesktopSuiteCheck', args: ['win', 'suiteContext'] },
    { module: './ArticleInbox_Check_CodexV18.mjs', exportName: 'runArticleStorageCompatibilityCheck', args: ['win', 'articleContext'] },
  ] }),
  electron('notes-v22', '笔记自动发现', 'NOTES_V22_VERIFY_OK', './Notes_AutoDiscovery_Check_CodexV22.mjs', 'runNotesAutoDiscoveryCheck', ['win', 'noteContext'], { cleanup: 'exit' }),
  electron('markdown-v23', 'Markdown 阅读与实时预览', 'MARKDOWN_V23_VERIFY_OK', './Markdown_Check_CodexV23.mjs', 'runMarkdownCheck', ['win', 'noteContext'], { cleanup: 'exit' }),
  electron('folders-v23', '真实文件夹与外部自动发现', 'FOLDERS_V23_VERIFY_OK', './Folder_Check_CodexV23.mjs', 'runFolderCheck', ['win', 'noteContext'], { cleanup: 'exit' }),
  electron('v23', 'V23 首页、收藏与剪贴页', 'V23_VERIFY_OK', './Home_Check_CodexV23.mjs', 'runV23HomeCheck', ['win', 'homeContext'], { flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'], cleanup: 'close-suite-browser', steps: [
    { module: './Home_Check_CodexV23.mjs', exportName: 'runV23HomeCheck', args: ['win', 'homeContext'] },
    { module: './Web_Collection_Check_CodexV23.mjs', exportName: 'runWebCollectionCheck', args: ['win', 'webCollectionContext'] },
    { module: './Clipboard_Page_Check_CodexV23.mjs', exportName: 'runClipboardPageCheck', args: ['win', 'clipboardContext'] },
  ] }),
  electron('startup-v23', 'V23 开屏', 'STARTUP_V23_VERIFY_OK', './Startup_Check_CodexV23.mjs', 'runStartupCheck', ['win', 'startupContext'], { path: '/?verify=1&startup=1', flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'], cleanup: 'exit' }),
  electron('templates-v23', 'Markdown 模板', 'TEMPLATES_V23_VERIFY_OK', './Templates_Check_CodexV23.mjs', 'runTemplatesCheck', ['win', 'templatesContext'], { cleanup: 'exit' }),
  electron('layout-v23', 'V23 布局', 'LAYOUT_V23_VERIFY_OK', './Layout_Check_CodexV23.mjs', 'runLayoutCheck', ['win', 'layoutContext'], { flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'], cleanup: 'exit' }),
  electron('quit-v17', '退出与状态恢复', 'QUIT_V17_VERIFY_OK', './Quit_Check_CodexV17.mjs', 'runQuitCheck', ['win', 'quitContext'], { cleanup: 'exit' }),
  electron('interaction', '交互与翻译', 'INTERACTION_VERIFY_OK', './Interaction_Check_CodexV14.mjs', 'runInteractionCheck', ['win', 'interactionContext'], { timeoutSeconds: 300, translationAssets: process.env.REVERSEWEAR_TRANSLATION_ASSETS, requires: process.env.REVERSEWEAR_TRANSLATION_ASSETS ? [process.env.REVERSEWEAR_TRANSLATION_ASSETS] : ['设置 REVERSEWEAR_TRANSLATION_ASSETS'], cleanup: 'exit', flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('language-life', '翻译、词典与生活工作台', 'LANGUAGE_LIFE_VERIFY_OK', './Language_Life_Check_CodexV13.mjs', 'runLanguageLifeCheck', ['win', 'languageContext'], { timeoutSeconds: 600, translationAssets: process.env.REVERSEWEAR_TRANSLATION_ASSETS, requires: process.env.REVERSEWEAR_TRANSLATION_ASSETS ? [process.env.REVERSEWEAR_TRANSLATION_ASSETS] : ['设置 REVERSEWEAR_TRANSLATION_ASSETS'], cleanup: 'quit' }),
  electron('wallpaper', '壁纸库隔离夹具', '"reloadRestoredState"', './Desktop_Check_CodexV6.mjs', 'runDesktopCheck', ['win', 'settings'], { page: 'focus', special: 'wallpaper', fixture: 'wallpaper', cleanup: 'exit', flags: ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'] }),
  electron('reflection', '灵感与全局搜索', 'REFLECTION_VERIFY_OK', './Reflection_Check_CodexV11.mjs', 'runReflectionCheck', ['win', 'reflectionContext'], { isolated: false, requires: ['系统剪贴板读写'], cleanup: 'exit' }),
  electron('capture', '快速捕获与系统剪贴板', 'CAPTURE_VERIFY_OK', './Capture_Check_CodexV10.mjs', 'runCaptureCheck', ['win', 'captureContext'], { isolated: false, requires: ['系统剪贴板', '全局快捷键', 'PowerShell SendKeys'], timeoutSeconds: 300, cleanup: 'exit' }),
];

export const checkRegistry = [
  { id: 'node', label: 'Node 单元测试', kind: 'node', success: '运行成功无报错', timeoutSeconds: 300, isolated: true },
  ...electronChecks,
];

export function listChecks({ includeExternal = false } = {}) {
  return checkRegistry.filter(check => includeExternal || check.isolated);
}

export function findElectronCheck(checking) {
  return electronChecks.find(check => check.id === checking) ??
    (typeof checking === 'string' && checking.endsWith('wallpaper.json')
      ? electronChecks.find(check => check.id === 'wallpaper') : undefined);
}
