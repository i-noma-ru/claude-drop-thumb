import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Thumb } from '../types'

const thumbs = atom({ plugin: 'drop-thumb', key: 'thumbs' } as const, [] as Thumb[])
// クリックで固定表示中のカードの番号（ホバーが届かない端末向け）
const open = atom({ plugin: 'drop-thumb', key: 'open' } as const, null as number | null)

// Claude Code は貼り付け・ドロップされた画像を
// <CLAUDE_CODE_TMPDIR>/<cwd のスラグ>/<セッション id>/images/<n>.png に保存し、
// プロンプト欄には [Image #n] の印だけを置く。ドロップは編集イベントを起こさないので、
// 200ms ごとにプロンプト欄を読んで印を探す。
const POLL_MS = 200
// サムネイルの置き場は Claude Code のユーザー固有一時フォルダ（0700）の中に作る。
// 共有の /tmp 直下に固定名で置くと、他ユーザーがシンボリックリンクを仕込める。
const THUMB_SUBDIR = 'drop-thumb'
// 端末は絵を実寸より大きく引き伸ばさないので、枠を埋められる画素数で作る（Retina で 16 列 ≈ 450px）
const THUMB_PX = 512
const COLUMNS = 16
// セルの縦横比（幅/高さ）。行数の見積もりに使う
const CELL_ASPECT = 0.45
// 元ファイル名の逆引きに使う場所（Spotlight が使えないときの予備）
const LOOKUP_DIRS = ['Downloads', 'Desktop', 'Pictures', 'Documents']
// Claude 本体が kitty 画像を描く端末。それ以外では絵を出さず文字だけにする
const IMAGE_TERMINALS = ['ghostty', 'kitty']

export function imageTagsIn(text: string): number[] {
  const found: number[] = []
  for (const m of text.matchAll(/\[Image #(\d+)\]/g)) found.push(Number(m[1]))
  return [...new Set(found)]
}

export function sessionSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

async function findImagesDir($: EngineInterface, tmp: string, id: string): Promise<string | null> {
  try {
    const entries = await $.fs.list(tmp)
    for (const en of entries) {
      if (en.kind !== 'dir') continue
      const candidate = `${tmp}/${en.name}/${id}`
      if (await $.fs.exists(candidate)) return `${candidate}/images`
    }
  } catch {
    // 読めなければ cwd からの推定に任せる
  }
  return null
}

export function abbreviateHome(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const failures = new Map<number, number>()

async function poll($: EngineInterface, imagesDir: string, thumbDir: string, home: string): Promise<void> {
  const { text } = await $.prompt.read()
  const tags = imageTagsIn(text)
  const current = await read($, thumbs)

  if (tags.length === 0) {
    if (current.length > 0) await update($, thumbs, () => [])
    return
  }

  const have = new Set(current.map(t => t.n))
  // 失敗した印は 10 回（約 2 秒）までしか試さない
  const missing = tags.filter(n => !have.has(n) && (failures.get(n) ?? 0) < 10)
  const gone = current.some(t => !tags.includes(t.n))
  if (missing.length === 0 && !gone) return

  // キャッシュは元の拡張子のまま（8.jpg など）なので、番号で探す
  let entries: { name: string }[] = []
  try {
    entries = await $.fs.list(imagesDir)
  } catch {
    entries = []
  }
  const made: Thumb[] = []
  for (const n of missing) {
    const file = entries.find(en => en.name.startsWith(`${n}.`))
    const t = file ? await makeThumb($, `${imagesDir}/${file.name}`, n, thumbDir, home) : null
    if (t) made.push(t)
    else failures.set(n, (failures.get(n) ?? 0) + 1)
  }
  await update($, thumbs, prev => {
    const kept = prev.filter(t => tags.includes(t.n))
    const known = new Set(kept.map(t => t.n))
    return [...kept, ...made.filter(t => !known.has(t.n))].sort((a, b) => a.n - b.n)
  })
}

async function makeThumb(
  $: EngineInterface, src: string, n: number, thumbDir: string, home: string,
): Promise<Thumb | null> {
  try {
    if (!(await $.fs.exists(src))) return null
    const { size: bytes } = await $.fs.stat(src)

    const dest = `${thumbDir}/${hash(src)}.png`
    const conv = await $.process.run([
      'sips', '-s', 'format', 'png', '-Z', String(THUMB_PX), src, '--out', dest,
    ])
    if (conv.exitCode !== 0) return null

    const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', src])
    const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
    const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
    if (!width || !height) return null

    const { base64 } = await $.fs.read(dest, { as: 'bytes' })
    const path = await findOriginal($, src, bytes, home)
    const name = path ? path.slice(path.lastIndexOf('/') + 1) : null
    return { n, path, name, png: base64, width, height, bytes }
  } catch {
    return null
  }
}

// ドロップされたファイルはキャッシュと同一バイトで保存されるので、サイズで候補を引き、
// 中身を比べて確定する。クリップボードからの貼り付けは元ファイルが無いので null。
async function findOriginal($: EngineInterface, cached: string, bytes: number, home: string): Promise<string | null> {
  const candidates: string[] = []
  try {
    const md = await $.process.run(['mdfind', `kMDItemFSSize == ${bytes}`], { timeoutMs: 3000 })
    for (const line of md.stdout.split('\n')) {
      const p = line.trim()
      if (p && !p.startsWith('/tmp/') && !p.startsWith('/private/tmp/')) candidates.push(p)
    }
  } catch {
    // Spotlight が使えない
  }
  if (candidates.length === 0 && home) {
    const dirs = LOOKUP_DIRS.map(d => `${home}/${d}`)
    try {
      const found = await $.process.run(
        ['find', ...dirs, '-maxdepth', '2', '-type', 'f', '-size', `${bytes}c`],
        { timeoutMs: 3000 },
      )
      for (const line of found.stdout.split('\n')) {
        const p = line.trim()
        if (p) candidates.push(p)
      }
    } catch {
      // 予備の探索も失敗
    }
  }
  for (const p of candidates.slice(0, 5)) {
    const same = await $.process.run(['cmp', '-s', cached, p])
    if (same.exitCode === 0) return p
  }
  return null
}

function hash(s: string): string {
  let acc = 2166136261
  for (let i = 0; i < s.length; i++) {
    acc ^= s.charCodeAt(i)
    acc = Math.imul(acc, 16777619) >>> 0
  }
  return acc.toString(16)
}

export const register: Register = on => {
  let busy = false
  let canDrawImages = false
  // カードのパス表示でホームを ~ に縮める（利用者名を画面に出さない）
  let homeDir = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.surface === null) return started

    try {
      const term = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
      canDrawImages = IMAGE_TERMINALS.some(t => term.startsWith(t))

      // 既定は /tmp/claude-<uid>（Orca は CLAUDE_CODE_TMPDIR で同じ場所を渡してくる）
      let tmp = await $.env.get('CLAUDE_CODE_TMPDIR')
      if (!tmp) {
        const uid = await $.process.run(['id', '-u'])
        tmp = `/tmp/claude-${uid.stdout.trim()}`
      }
      const id = await $.session.id()
      // cwd は途中で変わりうるので、一時フォルダ内でセッション id を持つ場所を探す
      const imagesDir = (await findImagesDir($, tmp, id)) ?? `${tmp}/${sessionSlug(e.cwd)}/${id}/images`
      const home = (await $.env.get('HOME')) ?? ''
      homeDir = home

      // 所有者専用で作り、シンボリックリンクにすり替えられていないことを確かめてから使う
      const thumbDir = `${tmp}/${THUMB_SUBDIR}`
      await $.process.run(['mkdir', '-m', '700', '-p', thumbDir])
      const check = await $.process.run(['test', '-d', thumbDir, '-a', '!', '-L', thumbDir])
      if (check.exitCode !== 0) return started

      $.clock.every(POLL_MS, () => {
        if (busy) return
        busy = true
        void poll($, imagesDir, thumbDir, home)
          .catch(() => {})
          .finally(() => {
            busy = false
          })
      })
    } catch {
      // 置き場が分からなければ何もしない
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    // 送信は止めない: 片付けに失敗しても next へ進む
    await update($, thumbs, () => []).catch(() => {})
    await update($, open, () => null).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, thumbs)
    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Image = 'Image' in ui && canDrawImages ? ui.Image : null
    const maxRows = Math.max(1, Math.min(10, e.props.maxRows - 3))
    const opened = await read($, open)

    // 1 行目: チップの列（クリックでカードを固定／解除）。2 行目以降: カード。
    // カードは帯の中（流れの中）に出す。帯の外（上）に置くと領域で切り取られて見えない。
    return (
      <Box flexDirection="column">
        <Box>
          {list.map(t => (
            <Box key={`chip${t.n}`} marginRight={2}>
              <Button
                plain
                dimColor={opened !== t.n}
                label={`#${t.n} ${t.name ?? '(pasted image)'}`}
                hover={{ scope: `card${t.n}` }}
                onPress={() => update($, open, prev => (prev === t.n ? null : t.n))}
              />
            </Box>
          ))}
        </Box>
        {list.map(t => {
          const rows = Math.max(1, Math.min(maxRows, Math.ceil((COLUMNS * t.height * CELL_ASPECT) / t.width)))
          const label = t.name ?? '(pasted image)'
          const pinned = opened === t.n
          return (
            <Box
              key={`card${t.n}`}
              display={pinned ? 'flex' : 'none'}
              hover={{ scope: `card${t.n}`, display: 'flex' }}
              flexDirection="column"
              alignSelf="flex-start"
              borderStyle="round"
              borderDimColor
              paddingX={1}
            >
              {Image ? (
                <Image key={`img${t.n}`} source={{ png: t.png }} columns={COLUMNS} rows={rows} alt={label} />
              ) : null}
              <Text>{label}</Text>
              <Text dimColor>
                {t.width}× {t.height} px · {formatBytes(t.bytes)}
              </Text>
              {t.path ? <Text dimColor>{abbreviateHome(t.path, homeDir)}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
