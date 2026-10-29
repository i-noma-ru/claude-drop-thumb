export type Thumb = {
  n: number
  /** 元ファイルの絶対パス（クリップボード貼り付けなど、見つからなければ null） */
  path: string | null
  name: string | null
  /** サムネイル PNG（base64）。絵を描けない端末・sips の無い環境では空文字 */
  png: string
  /** サムネイル PNG のパス（強制フラグの端末ではファイルとして渡す）。無ければ空文字 */
  file: string
  /** ピクセル寸法。読めなかったとき（4 MiB を超え sips も無い Windows）は 0 */
  width: number
  height: number
  bytes: number
}

declare module 'claude-code' {
  interface PluginState {
    'drop-thumb': { thumbs: Thumb[]; open: number | null; gen: number }
  }
}
