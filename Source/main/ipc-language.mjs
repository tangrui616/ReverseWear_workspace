import { translationDirection } from '../desktop_dictionaries.mjs';

export async function translateSuiteText(value, { dictionaries, translator }) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请先选择可翻译的文字。');
  const text = value.slice(0, 16000).trim();
  const direction = translationDirection(text);
  if (/^[a-z]+(?:['’-][a-z]+)*$/i.test(text) || /^\p{Script=Han}{1,8}$/u.test(text)) {
    const result = await dictionaries.lookup({ text, direction });
    const item = result.entries[0];
    if (item) return { text: (item.translations.length ? item.translations : item.definitions).join('\n') };
  }
  return translator.translate({ text, direction, engine: 'argos' });
}

/** @param {import('./ipc.mjs').RegisterHandler} register */
export function registerLanguageHandlers(register, { dictionaries, translator, vocabulary }) {
  const translationLabels = { argos: 'Argos Translate', opus: 'OPUS-MT', 'hy-mt2': 'Hy-MT2 1.8B' };
  register('translation:models', async () => {
    let available;
    try { available = await translator.status(); }
    catch (error) { return { models: [], error: error.message }; }
    return { models: Object.entries(translationLabels).map(([id, label]) => {
      const directions = available.engines.filter(engine => engine.id === id);
      return { id, label, available: directions.some(item => item.available),
        directions: directions.filter(item => item.available).map(item => item.direction),
        reason: directions.filter(item => !item.available).map(item => item.reason).filter(Boolean).join(' / ') };
    }) };
  });
  register('translation:lookup', async input => {
    const result = await dictionaries.lookup(input);
    const entry = result.entries[0];
    if (!entry) return { ...result, vocabulary: null };
    const gloss = (entry.translations.length ? entry.translations : entry.definitions).join('\n');
    const saved = gloss ? await vocabulary.saveVocabulary({ word: result.query, gloss, direction: result.direction,
      original: input.sentence, source: input.source }) : null;
    return { ...result, vocabulary: saved };
  });
  register('translation:translate', async input => {
    const direction = translationDirection(input?.text, input?.direction);
    const model = input?.model || 'argos';
    if (!Object.hasOwn(translationLabels, model)) throw new Error('请选择可用的离线翻译模型。');
    const started = performance.now();
    const terms = await vocabulary.matchedTerms(input?.text, direction);
    const result = await translator.translate({ text: input?.text, direction, engine: model });
    return { ...result, model, elapsedMs: performance.now() - started, terms };
  });
  register('translation:vocabulary', () => vocabulary.listVocabulary());
  register('translation:vocabulary-save', input => vocabulary.saveVocabulary(input));
  register('translation:review', async input => {
    await vocabulary.reviewVocabulary(input);
    return vocabulary.listVocabulary();
  });
  register('translation:terms', () => vocabulary.listTerms());
  register('translation:term-save', async input => {
    await vocabulary.saveTerm(input);
    return vocabulary.listTerms();
  });
  register('translation:term-remove', async id => {
    await vocabulary.removeTerm(id);
    return vocabulary.listTerms();
  });
}
