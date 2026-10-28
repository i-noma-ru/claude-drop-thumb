import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Thumb } from '../types'

const thumbs = atom({ plugin: 'drop-thumb', key: 'thumbs' } as const, [] as Thumb[])
// クリックで固定表示中のカードの番号（ホバーが届かない端末向け）
const open = atom({ plugin: 'drop-thumb', key: 'open' } as const, null as number | null)
// ファイル渡しの Image の generation。増やすと端末がサムネイルを読み直す。
// Orca はタブを切り替えると受け取った画像を捨てることがあり（stablyai/orca#30383）、
// Claude Code は同じ画像を送り直さない（key を変えても同じ bytes は送られなかった）。
const gen = atom({ plugin: 'drop-thumb', key: 'gen' } as const, 0)
// チップがある間、この間隔で generation を増やし、クリックなしでも絵を戻す
const REFRESH_MS = 2000
// チップ同士の間隔（列）
const CHIP_GAP = 1

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

// 端末での表示幅（列）。全角（CJK・全角記号など）は 2 列と数える
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

export function chipLabel(n: number, name: string | null): string {
  // 【】で囲み、並んだチップの境目を見分けやすくする
  return `【#${n} ${name ?? '(pasted image)'}】`
}

// 各チップの左端の列。カードをそのチップの真下に出すのに使う
export function chipOffsets(labels: string[], gap: number): number[] {
  const out: number[] = []
  let x = 0
  for (const l of labels) {
    out.push(x)
    x += displayWidth(l) + gap
  }
  return out
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
    return { n, path, name, png: base64, file: dest, width, height, bytes }
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
  // 強制フラグで描く端末（Orca 等）。ファイル渡しと定期の読み直しはここだけで使う
  let forced = false
  // カードのパス表示でホームを ~ に縮める（利用者名を画面に出さない）
  let homeDir = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (e.surface === null) return started

    try {
      const term = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
      // Claude 本体は強制フラグがあれば端末名を問わず描く（Orca 1.4.229 以降はこれで絵が出る）
      forced = (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) === '1'
      canDrawImages = forced || IMAGE_TERMINALS.some(t => term.startsWith(t))

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

      // 定期の読み直し（ちらつくならこのブロックごと消せばクリック時だけになる）
      if (forced) {
        $.clock.every(REFRESH_MS, () => {
          void read($, thumbs)
            .then(list => (list.length > 0 ? update($, gen, g => g + 1) : undefined))
            .catch(() => {})
        })
      }
    } catch {
      // 置き場が分からなければ何もしない
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    // 送信は止めない: 片付けに失敗しても next へ進む
    await update($, thumbs, () => []).catch(() => {})
    await update($, open, () => null).catch(() => {})
    await update($, gen, () => 0).catch(() => {})
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
    // 絵以外の行（#番号・名前・寸法・パス・枠の上下・チップ行）が 7 行。
    // 帯に収まらないと下の行から切れるので、チップ行が残るように絵の行数を抑える
    const maxRows = Math.max(1, Math.min(10, e.props.maxRows - 7))
    const opened = await read($, open)
    const generation = await read($, gen)
    const labels = list.map(t => chipLabel(t.n, t.name))
    const offsets = chipOffsets(labels, CHIP_GAP)
    // カード（枠 2 列＋余白 2 列＋絵）が右端からはみ出さない範囲で、チップの真上に寄せる
    const cardWidth = COLUMNS + 4
    const width = e.props.bodyColumns

    // 上: カード。最下行: チップの列（クリックでカードを固定／解除）。
    // 帯はプロンプトの上に下揃えなので、カードの出入りでチップ行は動かない。
    // カードは帯の中（流れの中）に出す。帯の外（上）に置くと領域で切り取られて見えない。
    return (
      <Box flexDirection="column">
        {list.map((t, i) => {
          const rows = Math.max(1, Math.min(maxRows, Math.ceil((COLUMNS * t.height * CELL_ASPECT) / t.width)))
          const label = t.name ?? '(pasted image)'
          const pinned = opened === t.n
          const left = Math.max(0, Math.min(offsets[i], width - cardWidth - 1))
          return (
            <Box
              key={`card${t.n}`}
              display={pinned ? 'flex' : 'none'}
              hover={{ scope: `card${t.n}`, display: 'flex' }}
              flexDirection="column"
              alignSelf="flex-start"
              marginLeft={left}
              borderStyle="round"
              borderDimColor
              paddingX={1}
            >
              <Text bold color="cyan">#{t.n}</Text>
              {Image ? (
                <Image
                  key={`img${t.n}`}
                  source={forced ? { file: t.file, format: 'png', generation } : { png: t.png }}
                  columns={COLUMNS}
                  rows={rows}
                  alt={label}
                />
              ) : null}
              <Text>{label}</Text>
              <Text dimColor>
                {t.width}× {t.height} px · {formatBytes(t.bytes)}
              </Text>
              {t.path ? <Text dimColor>{abbreviateHome(t.path, homeDir)}</Text> : null}
            </Box>
          )
        })}
        <Box>
          {list.map((t, i) => (
            <Box key={`chip${t.n}`} marginRight={CHIP_GAP}>
              <Button
                plain
                dimColor={opened !== t.n}
                label={labels[i]}
                hover={{ scope: `card${t.n}` }}
                onPress={async () => {
                  await update($, gen, g => g + 1)
                  await update($, open, prev => (prev === t.n ? null : t.n))
                }}
              />
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
