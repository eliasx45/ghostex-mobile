/// <reference types="node" />
/** Run with `bun test src/chat/native/composer/imageTiles.test.ts` from apps/mobile/app. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { canonicalDraft, imagesFirst, joinImages, splitImages } from './imageTiles';

const A = '[Image #1](/tmp/a.png)';
const B = '[Image #2](/tmp/b.png)';

describe('composer image tiles', () => {
  test('a pasted picture leaves only the typed text in the field', () => {
    const split = splitImages(`${A} dont like the calendars`, 0);
    assert.equal(split.visible, 'dont like the calendars');
    assert.deepEqual(split.images, [A]);
  });

  test('join and split round-trip the typed text', () => {
    for (const visible of ['', 'hello', 'hello ', 'a\n', 'a\n\n', 'two\nlines']) {
      const draft = joinImages(visible, [A, B]);
      const split = splitImages(draft, 0);
      assert.equal(split.visible, visible, JSON.stringify(draft));
      assert.deepEqual(split.images, [A, B]);
    }
  });

  test('a picture inserted after typing keeps the caret where the typing ended', () => {
    const draft = `hello ${A} `;
    const canonical = canonicalDraft(draft, draft.length);
    assert.equal(canonical.text, `hello \n\n${A}`);
    assert.equal(canonical.caret, 'hello '.length);
  });

  test('a picture in the middle closes up the sentence', () => {
    assert.equal(splitImages(`see ${A} here`, 0).visible, 'see here');
  });

  test('files and other references stay in the field', () => {
    const draft = 'look at [File #1](/tmp/a.txt)';
    assert.equal(splitImages(draft, 0).visible, draft);
    assert.equal(imagesFirst(draft), draft);
  });

  test('the message carries the pictures before the typed text', () => {
    assert.equal(imagesFirst(joinImages('fix it', [A, B])), `${A} ${B} fix it`);
    assert.equal(imagesFirst(joinImages('', [A])), A);
  });
});
