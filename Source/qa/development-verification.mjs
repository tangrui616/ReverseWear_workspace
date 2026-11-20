import { readFile } from 'node:fs/promises';
import { findElectronCheck } from './check-registry.mjs';

export function verificationPath(checking) {
  const check = findElectronCheck(checking);
  if (check?.path) return check.path;
  return check?.page === 'workbench' ? '/?verify=1' : '/?verify=1&view=focus';
}

export async function runDevelopmentVerification(context) {
  const check = findElectronCheck(context.checking);
  if (!check) throw new Error(`未登记的 Electron 验收项目：${context.checking}`);

  const values = {
    ...context,
    organizationContext: { documentsDirectory: context.documentsDirectory, workbench: context.workbench, markdown: context.markdown },
    noteContext: { documentsDirectory: context.documentsDirectory, workbench: context.workbench, fixtureRoot: context.fixtureRoot },
    startupContext: { fixtureRoot: context.fixtureRoot, documentsDirectory: context.documentsDirectory },
    templatesContext: { documentsDirectory: context.documentsDirectory },
    layoutContext: { fixtureRoot: context.fixtureRoot },
    homeContext: { fixtureRoot: context.fixtureRoot, documentsDirectory: context.documentsDirectory },
    publicCoreContext: { fixtureRoot: context.fixtureRoot, documentsDirectory: context.documentsDirectory },
    v17Context: { app: context.app, workbench: context.workbench, fixtureRoot: context.fixtureRoot },
    suiteContext: { suite: context.suite.testing, settings: context.settings, fixtureRoot: context.fixtureRoot, workbench: context.workbench },
    quitContext: { workbench: context.workbench, fixtureRoot: context.fixtureRoot },
    interactionContext: { documentsDirectory: context.documentsDirectory, workbench: context.workbench, life: context.life },
    languageContext: { documentsDirectory: context.documentsDirectory, workbench: context.workbench, life: context.life,
      globalSearch: context.globalSearch, mirror: context.mirror, app: context.app },
    reflectionContext: { documentsDirectory: context.documentsDirectory, workbench: context.workbench,
      ideas: context.ideas, weeklyReview: context.weeklyReview, markdown: context.markdown },
    captureContext: { openQuickCapture: context.openQuickCapture, setCaptureShortcut: context.setCaptureShortcut,
      ideas: context.ideas, workbench: context.workbench },
  };

  values.articleContext = { articles: context.articles, workbench: context.workbench,
    fixtureRoot: context.fixtureRoot, articleLinksOpened: context.articleLinksOpened };
  values.webCollectionContext = { browser: context.browser, workbench: context.workbench, fixtureRoot: context.fixtureRoot };
  values.clipboardContext = { suite: context.suite.testing, settings: context.settings, fixtureRoot: context.fixtureRoot };

  for (const step of check.steps) {
    const implementation = await import(step.module);
    const args = step.args.map(name => values[name]);
    await implementation[step.exportName](...args);
  }

  if (check.cleanup === 'close-suite-articles') {
    await context.suite.close();
    context.articles.close();
  } else if (check.cleanup === 'close-suite-browser') {
    await context.suite.close();
    context.browser.close();
  }
  if (check.special === 'wallpaper') {
    const report = JSON.parse(await readFile(context.checking, 'utf8'));
    if (report.error) context.app.exit(1);
  }
  console.log(check.success);
  if (check.cleanup === 'quit') context.app.quit();
  else if (check.cleanup === 'exit' || check.cleanup === 'close-suite-articles' || check.cleanup === 'close-suite-browser') context.app.exit(0);
}
