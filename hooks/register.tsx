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
// <一時フォルダ>/<cwd のスラグ>/<セッション id>/images/<n>.<元の拡張子> に保存し、
// プロンプト欄には [Image #n] の印だけを置く。一時フォルダは CLAUDE_CODE_TMPDIR、
// 無ければ macOS は /tmp/claude-<uid>、Windows は %TEMP%\claude（2.1.312 で実測）。
// ドロップは編集イベントを起こさないので、200ms ごとにプロンプト欄を読んで印を探す。
const POLL_MS = 200
// サムネイルの置き場は Claude Code のユーザー固有一時フォルダ（0700）の中に作る。
// 共有の /tmp 直下に固定名で置くと、他ユーザーがシンボリックリンクを仕込める。
const THUMB_SUBDIR = 'drop-thumb'
// 端末は絵を実寸より大きく引き伸ばさないので、枠を埋められる画素数で作る（Retina で 16 列 ≈ 450px）
const THUMB_PX = 512
const COLUMNS = 16
// セルの縦横比（幅/高さ）。行数の見積もりに使う
const CELL_ASPECT = 0.45
// 元ファイル名の逆引きに使う場所（Spotlight が使えないとき・Windows）
const LOOKUP_DIRS = ['Downloads', 'Desktop', 'Pictures', 'Documents']
// 逆引きで潜る深さと、1 フォルダで見る項目数の上限（巨大なフォルダで止まらないように）
const LOOKUP_DEPTH = 2
const LOOKUP_ENTRIES = 2000
const LOOKUP_LISTS = 200
// $.fs.read が受け付ける大きさの上限（型定義: 4 MiB を超えると拒む）
const READ_LIMIT = 4 * 1024 * 1024
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
  const rest = path.slice(home.length)
  return path.startsWith(home) && (rest[0] === '/' || rest[0] === '\\') ? `~${rest}` : path
}

// Windows の \ 区切りも扱う
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

// 画像の寸法を先頭のバイトから読む。外部コマンド（sips）を使わないので Windows でも動く。
// 読めない形式・途中で切れたファイルは null
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => b[i] ?? 0
  const be16 = (i: number) => (at(i) << 8) | at(i + 1)
  const le16 = (i: number) => at(i) | (at(i + 1) << 8)
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16)
  const le32 = (i: number) => le24(i) | (at(i + 3) << 24)
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)

  if (b.length >= 24 && at(0) === 0x89 && ascii(1, 3) === 'PNG') return ok(be32(16), be32(20))
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return ok(le16(6), le16(8))
  // BMP は上下反転の画像で高さが負になる
  if (b.length >= 26 && ascii(0, 2) === 'BM') return ok(Math.abs(le32(18)), Math.abs(le32(22)))
  if (b.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    // 寸法の入る位置まで届いていない（切れた）ものは null。+1 する形式で 1×1 を返さないため
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ' && b.length >= 30) return ok(le16(26) & 0x3fff, le16(28) & 0x3fff)
    if (chunk === 'VP8L' && b.length >= 25 && at(20) === 0x2f) {
      const bits = le32(21)
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X' && b.length >= 30) return ok(le24(24) + 1, le24(27) + 1)
    return null
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // マーカーを長さで飛ばしながら SOF（C0〜CF のうち C4・C8・CC 以外）を探す
    let i = 2
    // SOF の高さ・幅は i+5〜i+8 にある
    while (i + 8 < b.length) {
      if (at(i) !== 0xff) return null
      const marker = at(i + 1)
      if (marker === 0xff) {
        i += 1
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok(be16(i + 7), be16(i + 5))
      }
      i += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + be16(i + 2)
    }
    return null
  }
  return null
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

const failures = new Map<number, number>()

// thumbDir が null のとき（絵を描けない端末）は縮小せず、文字の情報だけを作る。
// 画像の置き場は印があるときだけ確かめる（貼る前はフォルダが無く、毎回探し直すと無駄なため）
async function poll(
  $: EngineInterface, imagesDirNow: () => Promise<string>, thumbDir: string | null, home: string,
): Promise<void> {
  const { text } = await $.prompt.read()
  const tags = imageTagsIn(text)
  // 会話が替わっていたら、前の会話のチップと失敗回数をここで捨ててから比べる
  if (tags.length > 0) await imagesDirNow()
  const current = await read($, thumbs)

  // 消えた印の失敗回数は忘れる（同じ番号を貼り直したら試し直す）
  for (const n of failures.keys()) if (!tags.includes(n)) failures.delete(n)

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
  const imagesDir = await imagesDirNow()
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
  $: EngineInterface, src: string, n: number, thumbDir: string | null, home: string,
): Promise<Thumb | null> {
  try {
    if (!(await $.fs.exists(src))) return null
    const { size: bytes } = await $.fs.stat(src)
    // $.fs.read は 4 MiB を超えるファイルを拒むので、大きい画像は sips に寸法を聞く（macOS）。
    // 聞けない環境（Windows）では寸法 0＝不明のままチップとカードを出す
    const original = bytes <= READ_LIMIT ? (await $.fs.read(src, { as: 'bytes' })).base64 : null
    const dims = original !== null ? imageSize(bytesOf(original)) : await sipsSize($, src)
    if (original !== null && !dims) return null

    // 縮小は macOS の sips だけ。無い・失敗したときは絵なしでチップとカードを出す
    let png = ''
    let file = ''
    if (thumbDir) {
      const dest = `${thumbDir}/${hash(src)}.png`
      const conv = await $.process
        .run(['sips', '-s', 'format', 'png', '-Z', String(THUMB_PX), src, '--out', dest])
        .catch(() => null)
      // 縮小した PNG が読めなくても、文字の情報は出す
      const thumb = conv?.exitCode === 0 ? await $.fs.read(dest, { as: 'bytes' }).catch(() => null) : null
      if (thumb) {
        png = thumb.base64
        file = dest
      }
    }

    const path = await findOriginal($, src, original, bytes, home)
    const name = path ? baseName(path) : null
    return { n, path, name, png, file, width: dims?.width ?? 0, height: dims?.height ?? 0, bytes }
  } catch {
    return null
  }
}

async function sipsSize($: EngineInterface, src: string): Promise<{ width: number; height: number } | null> {
  const out = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', src]).catch(() => null)
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out?.stdout ?? '')?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out?.stdout ?? '')?.[1] ?? 0)
  return width && height ? { width, height } : null
}

// ドロップされたファイルはキャッシュと同一バイトで保存されるので、サイズで候補を引き、
// 中身を比べて確定する。クリップボードからの貼り付けは元ファイルが無いので null。
// cached は一時ファイルの中身（base64）。4 MiB を超えて読めないときは null で、比較は cmp に任せる。
// 中身が一致したと確かめられないものは元ファイルとしない（同じサイズの別のファイルを名乗らせないため）
async function findOriginal(
  $: EngineInterface, src: string, cached: string | null, bytes: number, home: string,
): Promise<string | null> {
  const same = async (p: string): Promise<boolean> => {
    if (cached !== null) return (await $.fs.read(p, { as: 'bytes' }).catch(() => null))?.base64 === cached
    return (await $.process.run(['cmp', '-s', src, p]).catch(() => null))?.exitCode === 0
  }
  // 一時フォルダの中（キャッシュ自身を含む）は候補にしない
  const tmpRoot = src.slice(0, Math.max(src.lastIndexOf('/images/'), src.lastIndexOf('\\images\\')))
  const usable = (p: string) =>
    p !== src && !p.startsWith('/tmp/') && !p.startsWith('/private/tmp/') && !(tmpRoot && p.startsWith(tmpRoot))

  // macOS は Spotlight が速い。Windows では起動に失敗して下の走査へ進む
  const md = await $.process.run(['mdfind', `kMDItemFSSize == ${bytes}`], { timeoutMs: 3000 }).catch(() => null)
  const indexed = (md?.stdout ?? '').split('\n').map(l => l.trim()).filter(p => p && usable(p))
  for (const p of indexed.slice(0, 5)) if (await same(p)) return p

  // Spotlight に無い・一致しなかったときは、ホームのよく使うフォルダを走る
  if (!home) return null
  const sep = home.includes('\\') ? '\\' : '/'
  const tried = new Set(indexed.slice(0, 5))
  // フォルダの多いホームで表示が遅れないよう、一覧を取る回数と比べる件数に上限を置く
  let lists = 0
  let compared = 0
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (++lists > LOOKUP_LISTS) return null
    const entries = await $.fs.list(dir).catch(() => [])
    for (const en of entries.slice(0, LOOKUP_ENTRIES)) {
      const p = `${dir}${sep}${en.name}`
      if (en.kind === 'file' && en.size === bytes && usable(p) && !tried.has(p)) {
        if (++compared > 5) return null
        if (await same(p)) return p
      } else if (en.kind === 'dir' && depth > 1 && !en.name.startsWith('.')) {
        const found = await walk(p, depth - 1)
        if (found) return found
      }
    }
    return null
  }
  for (const d of LOOKUP_DIRS) {
    const found = await walk(`${home}${sep}${d}`, LOOKUP_DEPTH)
    if (found) return found
  }
  return null
}

// 一時フォルダの候補を順に試す。OS を名前で判定しない。
// Windows では初めて画像を貼るまで %TEMP%\claude が無いことがあるので、id が使えなければ在るかを問わずそこにする
async function claudeTmpDir($: EngineInterface): Promise<string | null> {
  const set = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (set) return set
  const temp = await $.env.get('TEMP')
  if (temp && (await $.fs.exists(`${temp}\\claude`))) return `${temp}\\claude`
  const uid = await $.process.run(['id', '-u']).catch(() => null)
  if (uid?.exitCode === 0) return `/tmp/claude-${uid.stdout.trim()}`
  return temp ? `${temp}\\claude` : null
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

      // macOS の Orca は CLAUDE_CODE_TMPDIR で同じ場所を渡してくる
      const tmp = await claudeTmpDir($)
      if (!tmp) return started
      // /clear で会話が替わるとセッション id が変わり、session.start は来ない（型定義 SessionEndInput）。
      // だから毎回 id を確かめ、変わったら画像の置き場を探し直して前の会話のチップを消す。
      // cwd は途中で変わりうるので、一時フォルダ内でセッション id を持つ場所を探す
      let sessionId = ''
      let imagesDir = ''
      const imagesDirNow = async (): Promise<string> => {
        const id = await $.session.id()
        if (id !== sessionId || !(await $.fs.exists(imagesDir))) {
          if (id !== sessionId) {
            failures.clear()
            if (sessionId) await update($, thumbs, () => [])
          }
          sessionId = id
          imagesDir = (await findImagesDir($, tmp, id)) ?? `${tmp}/${sessionSlug(e.cwd)}/${id}/images`
        }
        return imagesDir
      }
      // Windows の HOME は Git Bash の形（/c/Users/…）のことがあるので USERPROFILE を先に見る
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
      homeDir = home

      // サムネイルの置き場は絵を描ける端末のときだけ作る。
      // 所有者専用で作り、シンボリックリンクにすり替えられていないことを確かめてから使う
      let thumbDir: string | null = null
      if (canDrawImages) {
        const dir = `${tmp}/${THUMB_SUBDIR}`
        const made = await $.process.run(['mkdir', '-m', '700', '-p', dir]).catch(() => null)
        const check = made && (await $.process.run(['test', '-d', dir, '-a', '!', '-L', dir]).catch(() => null))
        if (check?.exitCode === 0) thumbDir = dir
        else canDrawImages = false
      }

      $.clock.every(POLL_MS, () => {
        if (busy) return
        busy = true
        void poll($, imagesDirNow, thumbDir, home)
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
    // 後ろに読み込まれる MOD の帯（~/.claude/mods 内は名前順なので qa-guide・ruling-tracker・vime）を
    // 消さず、カードとチップの上に置く。チップは入力欄の直上（最下行）のまま
    const below = await next(e)
    const hasBelow = below.type !== 'engine'
    // 絵以外の行（#番号・名前・寸法・パス・枠の上下・チップ行）が 7 行、上の帯に 1 行。
    // 帯に収まらないと下の行から切れるので、チップ行が残るように絵の行数を抑える
    const maxRows = Math.max(1, Math.min(10, e.props.maxRows - 7 - (hasBelow ? 1 : 0)))
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
        {hasBelow ? below : null}
        {list.map((t, i) => {
          const rows = t.width ? Math.max(1, Math.min(maxRows, Math.ceil((COLUMNS * t.height * CELL_ASPECT) / t.width))) : maxRows
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
              {Image && t.png ? (
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
                {t.width ? `${t.width}× ${t.height} px · ` : ''}{formatBytes(t.bytes)}
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
