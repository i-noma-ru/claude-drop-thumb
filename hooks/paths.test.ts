import { expect, test } from 'claude-code/testing'

import { abbreviateHome, formatBytes, imageTagsIn, sessionSlug } from './register'

test('ホームを ~ に縮める', () => {
  expect(abbreviateHome('/Users/alice/Downloads/a.png', '/Users/alice')).toBe('~/Downloads/a.png')
  expect(abbreviateHome('/Users/alice', '/Users/alice')).toBe('~')
  // 別ユーザーや前方一致だけのパスは縮めない
  expect(abbreviateHome('/Users/alicee/a.png', '/Users/alice')).toBe('/Users/alicee/a.png')
  expect(abbreviateHome('/tmp/a.png', '')).toBe('/tmp/a.png')
})

test('印 1 つ', () => {
  expect(imageTagsIn('[Image #1] これ何？')).toEqual([1])
})
test('印 2 つ・重複は 1 つに', () => {
  expect(imageTagsIn('[Image #2] と [Image #3] と [Image #2]')).toEqual([2, 3])
})
test('印なし', () => {
  expect(imageTagsIn('ただの文章 Image #1')).toEqual([])
})
test('cwd のスラグは英数字以外を - にする', () => {
  expect(sessionSlug('/Users/alice')).toBe('-Users-alice')
  expect(sessionSlug('/Users/me/my.proj dir')).toBe('-Users-me-my-proj-dir')
})
test('バイト数の表示', () => {
  expect(formatBytes(84855)).toBe('83 KB')
  expect(formatBytes(1989375)).toBe('1.9 MB')
  expect(formatBytes(512)).toBe('512 B')
})
