import { expect, mock, test } from 'claude-code/testing'

// Windows（2.1.312 の実測）の形: CLAUDE_CODE_TMPDIR は無く、画像は %TEMP%\claude\<プロジェクト>\<セッション id>\images。
// sips・mdfind・cmp・id は起動できない。$.fs.read は 4 MiB を超えると拒む（型定義）。
// テストの土台は Mac で動き、C:\ で始まるパスを相対パスとして読み替えるので、/ で始めておく
// （\ 区切りの扱いは paths.test.ts の abbreviateHome・baseName で確かめる）
const TEMP = '/w/Temp'
const HOME = '/w/me'
const TMP = `${TEMP}\\claude`
const IMAGES = `${TMP}/C--Users-me-proj/sid/images`
const BIG = 5 * 1024 * 1024
// Windows の claude plugin test は模擬へ渡すパスを C:\… の形に書き換える（Windows での実測・2026-10-29）。
// 両方の OS で同じ比べ方になるよう、\ を / にして先頭のドライブ名を外してから比べる
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// 640×480 の PNG の先頭（寸法の読み取りに要る範囲）
const PNG = btoa(String.fromCharCode(0x89, ...[...'PNG\r\n\x1a\n'].map(c => c.charCodeAt(0)),
  0, 0, 0, 13, ...[...'IHDR'].map(c => c.charCodeAt(0)), 0, 0, 2, 128, 0, 0, 1, 224))
const PNG_SIZE = 24

const BAND = {
  plugin: 'drop-thumb',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

function textsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (typeof node !== 'object' || node === null) return []
  const { props = {}, children = [] } = node as { props?: Record<string, unknown>; children?: unknown[] }
  const own = typeof props.label === 'string' ? [props.label] : []
  return [...own, ...children.flatMap(textsOf)]
}

test('Windows: 外部コマンドなしでチップとカードを出す。4 MiB を超える画像も寸法なしで出す', async ($, on) => {
  const clock = mock.clock(on)
  // HOME は Git Bash の形になりうるので、USERPROFILE が先に使われることも見る
  const env: Record<string, string> = { TEMP, USERPROFILE: HOME, HOME: '/c/Users/me', TERM_PROGRAM: 'Orca' }
  const sizes: Record<string, number> = { [norm(`${IMAGES}/1.png`)]: PNG_SIZE, [norm(`${IMAGES}/2.jpg`)]: BIG }
  const ran: string[] = []
  let sessionId = 'sid'
  // 起動の時点では %TEMP%\claude がまだ無い（初めて画像を貼るときに作られる）
  let tmpExists = false

  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    throw new Error(`${e.argv[0]}: not found`)
  })
  on('fs.exists', ($, e) => ({
    value: (tmpExists && norm(e.path) === norm(TMP))
      || [`${TMP}/C--Users-me-proj/sid`, IMAGES].map(norm).concat(Object.keys(sizes)).includes(norm(e.path)),
  }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: sizes[norm(e.path)] ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.list', ($, e) => {
    const file = (name: string, size: number) => ({ name, kind: 'file', size, mtimeMs: 0, isLink: false })
    const p = norm(e.path)
    if (p === norm(TMP)) return { value: [{ name: 'C--Users-me-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (p === norm(IMAGES)) return { value: [file('1.png', PNG_SIZE), file('2.jpg', BIG)] }
    if (p === `${HOME}/Downloads`) return { value: [file('a.png', PNG_SIZE), file('写真.jpg', BIG)] }
    return { value: [] }
  })
  on('fs.read', ($, e) => {
    if ([`${IMAGES}/1.png`, `${HOME}/Downloads/a.png`].map(norm).includes(norm(e.path))) return { value: { base64: PNG } }
    throw new Error('over 4 MiB')
  })
  on('prompt.read', () => ({ value: { text: '[Image #1] と [Image #2]', cursor: 0 } }))

  await $.session.start({ cwd: '/w/me/proj', surface: 'terminal', isInteractive: true })
  tmpExists = true
  await clock.advance(400)
  await clock.settle()

  const ui = await $.ui.mount(BAND)
  const texts = textsOf(await ui.drawn()).join('\n')
  expect(texts).toContain('【#1 a.png】')
  // 寸法とサイズは Text の子 2 つに分かれて描かれる
  expect(texts).toContain('640× 480 px · \n24 B')
  expect(texts).toContain('~/Downloads/a.png')
  // 4 MiB を超える画像: 寸法は読めないのでサイズだけ。中身を比べられないので、
  // 同じサイズの 写真.jpg があっても元ファイルとはしない（レビューで見つかった反例・2026-10-29）
  expect(texts).toContain('【#2 (pasted image)】')
  expect(texts).toContain('(pasted image)\n\n5.0 MB')
  expect(texts).not.toContain('0× 0 px')
  expect(texts).not.toContain('写真.jpg')
  // 絵を描かない端末なので縮小（sips -s format png）は呼ばない。大きい画像の寸法を聞く sips -g は試して失敗する
  expect(ran.filter(a => a.startsWith('sips -s'))).toEqual([])
  expect(ran.filter(a => a.startsWith('sips -g'))).toHaveLength(1)
  await ui.unmount()

  // /clear で会話が替わる（セッション id が変わり、session.start は来ない）と、前の会話のチップを出さない
  sessionId = 'sid2'
  await clock.advance(400)
  await clock.settle()
  const after = await $.ui.mount(BAND)
  expect(textsOf(await after.drawn()).join('\n')).not.toContain('【#1')
  await after.unmount()
})
