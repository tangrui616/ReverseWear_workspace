import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranslationInput, cleanPdfSelection, cleanSelectedText, normalizeDictionaryEntries, normalizeModelList } from '../dist/translation.mjs';

test('PDF selection joins wrapped words and removes soft hyphens', () => {
  assert.equal(cleanSelectedText('patho-\nlogical voice\u00ad analysis'), 'pathological voice analysis');
});

test('selection cleanup preserves Chinese and punctuation while collapsing line breaks', () => {
  assert.equal(cleanSelectedText('病理性\n嗓音分析： / 医学 AI'), '病理性 嗓音分析： / 医学 AI');
});

test('empty selection stays empty', () => {
  assert.equal(cleanSelectedText(' \n\t '), '');
});

test('unified translation input distinguishes words from sentences in English and Chinese', () => {
  assert.equal(classifyTranslationInput('decision'), 'word');
  assert.equal(classifyTranslationInput('can’t'), 'word');
  assert.equal(classifyTranslationInput('决策'), 'word');
  assert.equal(classifyTranslationInput('这是一个中文短句。'), 'sentence');
  assert.equal(classifyTranslationInput('A short sentence.'), 'sentence');
});

test('PDF cleanup removes matched repeated margin lines and isolated page numbers', () => {
  assert.equal(cleanPdfSelection('Journal header\nA patho-\nlogical voice study\n14', ['Journal header']), 'A pathological voice study');
  assert.equal(cleanSelectedText('mix'), 'mix');
  assert.equal(cleanPdfSelection('I'), 'I');
  assert.equal(cleanSelectedText('2026'), '2026');
});

test('model picker accepts list and wrapped engine responses', () => {
  assert.deepEqual(normalizeModelList({ models: [{ id: 'argos-en-zh', label: 'Argos EN-ZH', available: true, directions: ['en-zh'] }, { id: 'missing', available: false, reason: '缺少文件' }] }), [
    { id: 'argos-en-zh', label: 'Argos EN-ZH', available: true, directions: ['en-zh'], reason: '' },
    { id: 'missing', label: 'missing', available: false, directions: [], reason: '缺少文件' },
  ]);
  assert.deepEqual(normalizeModelList(['opus-mt-en-zh']), [{ id: 'opus-mt-en-zh', label: 'opus-mt-en-zh', available: true, directions: [] }]);
});

test('dictionary entry arrays accept strings and structured definitions', () => {
  assert.deepEqual(normalizeDictionaryEntries({ entries: [{ word: 'focus', translation: '专注;焦点', definitions: [{ definition: 'a center of interest' }] }] }), [{ word: 'focus', translation: '专注;焦点', definitions: ['a center of interest'], translations: ['专注', '焦点'] }]);
});
