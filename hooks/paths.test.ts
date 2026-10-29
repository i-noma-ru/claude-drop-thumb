import { expect, test } from 'claude-code/testing'

import {
  abbreviateHome, baseName, chipLabel, chipOffsets, displayWidth, formatBytes, imageSize, imageTagsIn, sessionSlug,
} from './register'

test('ホームを ~ に縮める', () => {
  expect(abbreviateHome('/Users/alice/Downloads/a.png', '/Users/alice')).toBe('~/Downloads/a.png')
  expect(abbreviateHome('/Users/alice', '/Users/alice')).toBe('~')
  // 別ユーザーや前方一致だけのパスは縮めない
  expect(abbreviateHome('/Users/alicee/a.png', '/Users/alice')).toBe('/Users/alicee/a.png')
  expect(abbreviateHome('/tmp/a.png', '')).toBe('/tmp/a.png')
})

test('Windows のパスもホームを ~ に縮め、名前を取り出す', () => {
  expect(abbreviateHome('C:\\Users\\alice\\Downloads\\a.png', 'C:\\Users\\alice')).toBe('~\\Downloads\\a.png')
  expect(abbreviateHome('C:\\Users\\alicee\\a.png', 'C:\\Users\\alice')).toBe('C:\\Users\\alicee\\a.png')
  expect(baseName('C:\\Users\\alice\\写真.jpg')).toBe('写真.jpg')
  expect(baseName('/Users/alice/a.png')).toBe('a.png')
})

// 各形式の先頭のバイトだけを組み立てる（寸法の読み取りに要る範囲）
const bytesOf = (...parts: (number | string)[][]) =>
  Uint8Array.from(parts.flat().flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [p])))
const be16 = (n: number) => [n >> 8, n & 255]
const le16 = (n: number) => [n & 255, n >> 8]
const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]

test('画像の寸法を先頭のバイトから読む（PNG・GIF・BMP・JPEG・WebP 3 種）', () => {
  expect(imageSize(bytesOf([0x89], ['PNG\r\n', 0x1a, '\n'], be32(13), ['IHDR'], be32(640), be32(480)))).toEqual({ width: 640, height: 480 })
  expect(imageSize(bytesOf(['GIF89a'], le16(320), le16(200)))).toEqual({ width: 320, height: 200 })
  // BMP は上下反転の画像で高さが負になる
  expect(imageSize(bytesOf(['BM'], Array(16).fill(0), le32(800), le32(-600 >>> 0)))).toEqual({ width: 800, height: 600 })
  // JPEG: APP0 を飛ばして SOF0 の高さ・幅を読む
  const app0 = [0xff, 0xe0, ...be16(16), ...Array(14).fill(0)]
  const sof0 = [0xff, 0xc0, ...be16(17), 8, ...be16(1080), ...be16(1920)]
  expect(imageSize(bytesOf([0xff, 0xd8], app0, sof0))).toEqual({ width: 1920, height: 1080 })
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8 '], le32(0), Array(6).fill(0), le16(500), le16(300)))).toEqual({ width: 500, height: 300 })
  // VP8L: 幅-1 と高さ-1 を 14 ビットずつ詰めて持つ
  const l = (500 - 1) | ((300 - 1) << 14)
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8L'], le32(0), [0x2f], le32(l)))).toEqual({ width: 500, height: 300 })
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8X'], le32(0), le32(0), le24(4999), le24(2999)))).toEqual({ width: 5000, height: 3000 })
})

test('画像でないもの・途中で切れたものは null', () => {
  expect(imageSize(bytesOf(['hello world, not an image']))).toBeNull()
  expect(imageSize(bytesOf([0x89], ['PNG']))).toBeNull()
  // SOF に届く前に終わる JPEG
  expect(imageSize(bytesOf([0xff, 0xd8, 0xff, 0xe0], be16(16)))).toBeNull()
  // 寸法の手前で切れた WebP を 1×1 と読まない（レビューで見つかった反例・2026-10-29）
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8L']))).toBeNull()
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8X']))).toBeNull()
  expect(imageSize(bytesOf(['RIFF'], le32(0), ['WEBPVP8 '], le32(0), Array(6).fill(0), [0xf4]))).toBeNull()
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
test('表示幅は全角を 2 列と数える', () => {
  expect(displayWidth('#1 a.png')).toBe(8)
  expect(displayWidth('#2 写真.jpg')).toBe(11)
})
test('カードはそのチップの左端に揃う', () => {
  const labels = [chipLabel(1, 'a.png'), chipLabel(2, '写真.jpg'), chipLabel(3, null)]
  expect(labels[2]).toBe('【#3 (pasted image)】')
  // 【】で 4 列増える: 12 列＋間隔 1 → 13、15 列＋間隔 1 → 29
  expect(chipOffsets(labels, 1)).toEqual([0, 13, 29])
})
