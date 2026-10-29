import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'drop-thumb',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const THUMB = { n: 1, path: null, name: 'a.png', png: '', file: '', width: 640, height: 480, bytes: 1000 }
const BELOW = { type: 'Text', children: ['📝 未記録の裁定 1 件'] } as const

function textsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (typeof node !== 'object' || node === null) return []
  const { props = {}, children = [] } = node as { props?: Record<string, unknown>; children?: unknown[] }
  const own = typeof props.label === 'string' ? [props.label] : []
  return [...own, ...children.flatMap(textsOf)]
}

// ~/.claude/mods の中では drop-thumb が qa-guide・ruling-tracker・vime より先に読み込まれる。
// 後ろの帯を消さずにカードとチップの上へ置き、チップは最下行のまま（2026-10-29）
test('後ろの MOD の帯を上に残し、チップは最下行に置く。後ろが描かなければ自分だけ', async ($, on) => {
  let drawsBelow = true
  on('ui.render', () => (drawsBelow ? BELOW : { type: 'engine', ref: 0 }))
  on('state.get', { plugin: 'drop-thumb', key: 'thumbs' }, () => ({ value: { value: [THUMB], version: 1 } }) as never)

  const ui = await $.ui.mount(BAND)
  const drawn = (await ui.drawn()) as { children: unknown[] }
  expect(drawn.children[0]).toMatchObject(BELOW)
  const texts = textsOf(drawn)
  expect(texts[0]).toBe('📝 未記録の裁定 1 件')
  expect(texts[texts.length - 1]).toBe('【#1 a.png】')
  await ui.unmount()

  drawsBelow = false
  const alone = await $.ui.mount(BAND)
  const only = textsOf(await alone.drawn())
  expect(only).not.toContain('📝 未記録の裁定 1 件')
  expect(only[only.length - 1]).toBe('【#1 a.png】')
  await alone.unmount()
})
