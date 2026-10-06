# drop-thumb

[English](README.md)

Claude Code のプロンプト欄に画像をドロップした際、`[Image #1]` という表示だけでは何を貼り付けたか判別しにくい。この mod は、プロンプトの直上に **「#1 ファイル名」のチップ** を表示する。チップをクリック（またはホバー）すると、**ファイル名・ピクセル寸法・ファイルサイズ・元のパス** を示すカードが開く。kitty 画像プロトコルに対応した端末（Ghostty / kitty）では **サムネイル** も表示する。

*A Claude Code mod that shows a chip (`#1 filename`) above the prompt for each dropped image, with a click/hover card (filename, pixel size, bytes, original path, and a thumbnail on kitty-graphics terminals).*

<img src="assets/demo-ghostty.gif" width="470" alt="Ghostty で画像をドロップし、チップにホバー・クリックしてカードを開くところ">

kitty 画像に対応しない端末では、同じカードがサムネイル抜きで表示される:

```
#1 201.jpg
╭──────────────────────────────╮
│  (thumbnail)                 │
│  201.jpg                     │
│  500× 500 px · 105 KB        │
│  ~/Downloads/201.jpg         │
╰──────────────────────────────╯
❯ [Image #1]
```

## インストール

マーケットプレイスから入れる場合:

```bash
claude plugin marketplace add i-noma-ru/drop-thumb
claude plugin install drop-thumb@drop-thumb
```

一時的に試す場合:

```bash
claude --plugin-dir /path/to/drop-thumb
```

常時有効にする場合: `~/.claude/settings.json` の `env` に追加する（複数ディレクトリを指定する場合は `:` 区切り）。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/drop-thumb"
  }
}
```

次回起動した Claude Code から有効になる。

## 動作

- 画像をドロップすると、プロンプト直上に `#n ファイル名` のチップが表示される。
- チップをクリックするとカードが開き、再度クリックすると閉じる。端末からマウス移動イベントを受け取れる環境では、ホバーでも開く。
- カードの表示項目: サムネイル（kitty 対応端末のみ）・ファイル名・ピクセル寸法（`幅× 高さ px`）・ファイルサイズ（バイト数）・元ファイルのパス（ホームは `~` に縮める）。
- プロンプトを送信するか、`[Image #n]` の文字を消すと、チップとカードは消える。

## 対応する画像形式

PNG・JPEG・GIF・WebP・BMP。
Claude Code 本体がプロンプトで「画像」として受け付ける拡張子に準じる（HEIC・TIFF・SVG などは Claude Code 側で `[Image #n]` として認識されない）。GIF は先頭フレームのみがサムネイルとして表示される。

## 対応端末

| 端末 | チップ・カード | サムネイル |
| --- | --- | --- |
| Ghostty, kitty | 表示 | 表示 |
| それ以外（Terminal.app, iTerm2, Orca など） | 表示 | 非表示（文字情報のみ） |

サムネイルは Claude Code の `Image` 要素で描画する。Claude Code は端末名が `kitty` または `ghostty` の場合だけ画像を描くため、本 mod もその他の端末では画像を表示しない。
Orca（Electron 製の端末アプリ。xterm.js ベース）は kitty プロトコルの Unicode プレースホルダ方式を解釈しないため、`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` で強制表示すると表示が崩れる。この変数は使わないほうがよい。

## 仕組み

1. Claude Code はドロップされた画像を一時フォルダ `<CLAUDE_CODE_TMPDIR または /tmp/claude-<uid>>/<プロジェクト>/<セッション id>/images/<n>.<拡張子>` に保存し、プロンプトには `[Image #n]` の文字だけを置く。ドロップ操作では編集イベントが発生しないため、本 mod は 200 ms ごとにプロンプト欄をポーリングして `[Image #n]` を検知する。
2. 検知した画像を `sips`（macOS 標準）で 512 px の PNG に縮小し、base64 エンコードして `Image` 要素に渡す。
3. 保存された画像は元ファイルと同一のバイト列であるため、Spotlight（`mdfind`）で同一ファイルサイズの候補を検索し、`cmp` で内容を比較して元のパスを特定する。Spotlight が利用できない環境では、`~/Downloads`、`~/Desktop`、`~/Pictures`、`~/Documents` を `find` で探す。

## 動作要件

- Claude Code v2.1.287 以降（mods 対応。mod は Claude Code のプラグインの一形態で、コマンドや設定では `plugin` と表記される）
- macOS（`sips`・`mdfind`・`cmp` を使用するため。Linux / Windows は未対応）

## プライバシーと安全性

外部へのネットワーク通信は一切行わない。読むのは、Claude Code の一時フォルダにある画像と、サイズが一致した候補ファイルの中身（元ファイルかどうかを比べるため）だけ。書くのは、Claude Code のユーザー固有一時フォルダ（パーミッション `0700` で所有者だけが開ける）の中の `drop-thumb/` に作るサムネイルだけで、共有の `/tmp` 直下には書かない。`claude plugin validate <フォルダ>` を実行すると、フックするイベントと呼び出す API の一覧を確認できる。

## 制限

- クリップボードから直接貼り付けた画像には元ファイルが無いので、チップには `(pasted image)` と出る。
- サムネイルの行数はセルの縦横比を 0.45 と仮定して算出するため、端末やフォント環境によって上下に余白が生じることがある。
- 同一サイズのファイルが複数存在する場合は、内容が一致した最初の 1 件を元ファイルと判定する。

## 開発

```bash
claude plugin validate .   # 構成と呼び出し API の検査
claude plugin test .       # hooks/*.test.ts を実行
tsc -p .                   # 一度読み込ませた後に型検査（.claude-plugin/types/ が生成される）
```

## 謝辞

「ドロップは編集イベントを起こさないので、プロンプト欄をポーリングして Claude Code のキャッシュ画像を使う」という手法は [jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view)（MIT）を参考にした。本リポジトリのコードは独自に実装したものであり、同プロジェクトのコードは含まない。

## ライセンス

MIT ライセンス。全文は `LICENSE` を参照。
