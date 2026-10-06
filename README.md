# drop-thumb

Claude Code のプロンプト欄に画像をドロップしたとき、`[Image #1]` という印だけでは何を貼ったか分からない。この mod は、プロンプトの直上に **「#1 ファイル名」のチップ** を出し、クリック（またはホバー）で **ファイル名・寸法・サイズ・元のパス** のカードを開く。kitty 画像プロトコルに対応した端末（Ghostty / kitty）では **サムネイル** も表示する。

*A Claude Code mod that shows a chip (`#1 filename`) above the prompt for each dropped image, with a click/hover card (filename, pixel size, bytes, original path, and a thumbnail on kitty-graphics terminals).*

```
#1 201.jpg
╭──────────────────────────────╮
│  (thumbnail)                 │
│  201.jpg                     │
│  500× 500 px · 105 KB        │
│  /Users/you/Downloads/201.jpg│
╰──────────────────────────────╯
❯ [Image #1]
```

## インストール

一度だけ試す:

```bash
claude --plugin-dir /path/to/drop-thumb
```

毎回読み込む: `~/.claude/settings.json` の `env` に追加する（複数のフォルダは `:` 区切り）。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/drop-thumb"
  }
}
```

次に起動した Claude Code から有効になる。

## 動作

- 画像をドロップすると、プロンプト直上にチップ `#n ファイル名` が並ぶ
- チップをクリックするとカードが開き、もう一度クリックで閉じる。マウス移動が端末から届く環境ではホバーでも開く
- カードの中身: サムネイル（kitty 対応端末のみ）・ファイル名・`幅× 高さ px`・バイト数・元ファイルの絶対パス
- プロンプトを送信するか、`[Image #n]` の印を消すと、チップとカードは消える

## 対応する画像形式

PNG・JPEG・GIF・WebP・BMP。
Claude Code 本体がプロンプトで「画像」として受け付ける拡張子に準じる（HEIC・TIFF・SVG などはそもそも `[Image #n]` にならない）。GIF は先頭のフレームだけがサムネイルになる。

## 対応端末

| 端末 | チップ・カード | サムネイル |
| --- | --- | --- |
| Ghostty, kitty | 出る | 出る |
| それ以外（Terminal.app, iTerm2, Orca など） | 出る | 出ない（文字情報のみ） |

サムネイルは Claude Code の `Image` 要素で描く。Claude Code は端末名が `kitty` か `ghostty` のときだけ画像を描くので、その他の端末ではこの mod も絵を出さない設計にしている。
Orca（xterm.js ベース）は kitty プロトコルの Unicode プレースホルダ方式を解釈しないため、`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` で強制すると表示が崩れる。推奨しない。

## 仕組み

1. Claude Code はドロップされた画像を一時フォルダ `<CLAUDE_CODE_TMPDIR または /tmp/claude-<uid>>/<プロジェクト>/<セッション id>/images/<n>.<拡張子>` に保存し、プロンプトには `[Image #n]` の印だけを置く。ドロップは編集イベントを起こさないので、mod は 200 ms ごとにプロンプト欄を読んで印を探す
2. 見つけた画像を `sips`（macOS 標準）で 512 px の PNG に縮小し、base64 で `Image` 要素に渡す
3. 保存された画像は元ファイルと同一バイトなので、Spotlight（`mdfind`）でサイズが同じファイルを引き、`cmp` で中身を比べて元のパスを確定する。Spotlight が使えないときは `~/Downloads` `~/Desktop` `~/Pictures` `~/Documents` を `find` で探す

## 動作要件

- Claude Code v2.1.287 以降（mods 対応）
- macOS（`sips`・`mdfind`・`cmp` を使う。Linux / Windows は未対応）

## プライバシーと安全性

ネットワーク通信は行わない。読むのは Claude Code の一時フォルダにある画像と、サイズが一致した候補ファイルの中身（比較のため）だけ。書くのは Claude Code のユーザー固有一時フォルダ（所有者だけが開ける `0700`）の中の `drop-thumb/` に置くサムネイルだけ。共有の `/tmp` 直下には書かない。`claude plugin validate <フォルダ>` を実行すると、フックするイベントと呼び出す API の一覧が確認できる。

## 制限

- クリップボードから直接貼った画像は元ファイルが無いので、チップは `(貼り付け画像)` になる
- サムネイルの行数はセルの縦横比を 0.45 と仮定して見積もるため、端末やフォントによって上下に余白が残ることがある
- 同じサイズのファイルが複数あるときは中身が一致した最初の 1 件を元ファイルとする

## 開発

```bash
claude plugin validate .   # 構成と呼び出し API の検査
claude plugin test .       # hooks/*.test.ts を実行
tsc -p .                   # 一度読み込ませた後に型検査（.claude-plugin/types/ が生成される）
```

## 謝辞

「ドロップは編集イベントを起こさないので、プロンプト欄をポーリングして Claude Code のキャッシュ画像を使う」という手法は [jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view)（MIT）から学んだ。本リポジトリのコードは独自に書いたもので、同プロジェクトのコードは含まない。

## ライセンス

MIT。全文は `LICENSE`。
