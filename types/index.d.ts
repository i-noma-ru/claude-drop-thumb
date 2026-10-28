export type Thumb = {
  n: number
  /** 元ファイルの絶対パス（クリップボード貼り付けなど、見つからなければ null） */
  path: string | null
  name: string | null
  png: string
  /** サムネイル PNG のパス（強制フラグの端末ではファイルとして渡す） */
  file: string
  width: number
  height: number
  bytes: number
}

declare module 'claude-code' {
  interface PluginState {
    'drop-thumb': { thumbs: Thumb[]; open: number | null; gen: number }
  }
}
