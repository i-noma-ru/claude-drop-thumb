# claude-drop-thumb

A Claude Code mod that shows a `#1 filename` chip above the prompt for each dropped image, with a card (filename, pixel size, bytes, original path) and, on kitty-graphics terminals, a thumbnail.
The `[Image #1]` marker alone doesn't tell you what you pasted, so this mod puts the file's name and details one click or hover away.

[日本語](README.ja.md)

## When to use

- When you drop several images into one prompt and need to tell `[Image #1]` from `[Image #2]` before you send.
- When you want to check the dimensions, file size, or original path of a dropped image without leaving the prompt.
- When you use Ghostty or kitty and want a thumbnail of each dropped image right above the prompt.

Not for you if you are on Linux or Windows (the mod runs `sips`, `mdfind`, and `cmp`, which are macOS tools), or if your Claude Code is older than v2.1.287.

## What it looks like

In Ghostty, dropping an image shows the chip; hovering over or clicking it opens the card with the thumbnail:

<img src="assets/demo-ghostty.gif" width="470" alt="Dropping an image, then hovering and clicking the chip to open the card, in Ghostty">

On terminals without kitty graphics, the same card appears without the thumbnail:

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

## Install

From the marketplace:

```bash
claude plugin marketplace add i-noma-ru/claude-drop-thumb
claude plugin install drop-thumb@claude-drop-thumb
```

Try it once:

```bash
claude --plugin-dir /path/to/claude-drop-thumb
```

Load every time: Add to `env` in `~/.claude/settings.json` (multiple directories separated by `:`).

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-drop-thumb"
  }
}
```

Takes effect starting from the next Claude Code launch.

## Requirements

- Claude Code v2.1.287 or later (mods support; a mod is a kind of Claude Code plugin, and commands and settings call it `plugin`)
- macOS (uses `sips`, `mdfind`, and `cmp`; Linux / Windows not supported)

## Supported Terminals

| Terminal | Chip / Card | Thumbnail |
| --- | --- | --- |
| Ghostty, kitty | Shown | Shown |
| Others (Terminal.app, iTerm2, Orca, etc.) | Shown | Not shown (text info only) |

Thumbnails are rendered using Claude Code's `Image` element. Because Claude Code renders images only when the terminal name is `kitty` or `ghostty`, this mod is designed not to display images on other terminals.
Orca (an Electron-based terminal app built on xterm.js) does not interpret the kitty protocol's Unicode placeholder method, so forcing images via `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` will result in broken rendering. Not recommended.

## Behavior

- Dropping an image displays `#n filename` chips right above the prompt.
- Clicking a chip opens the card, and clicking again closes it. It also opens on hover in environments where the terminal passes mouse movement events.
- Card contents: Thumbnail (kitty-compatible terminals only), filename, `width× height px`, file size in bytes, and the path of the original file (the home directory is shown as `~`).
- Submitting the prompt or deleting the `[Image #n]` marker removes the chips and card.

## Supported Image Formats

PNG, JPEG, GIF, WebP, BMP.
Follows the extensions that Claude Code itself accepts as "images" in the prompt (formats like HEIC, TIFF, and SVG do not become `[Image #n]` in the first place). For GIFs, only the first frame is displayed as a thumbnail.

## How It Works

1. Claude Code saves dropped images to a temporary directory `<CLAUDE_CODE_TMPDIR or /tmp/claude-<uid>>/<project>/<session id>/images/<n>.<ext>` and places only an `[Image #n]` marker in the prompt. Because dropping does not trigger an edit event, the mod inspects the prompt every 200 ms to detect markers.
2. Detected images are downscaled to 512 px PNGs using `sips` (built into macOS) and passed to the `Image` element as base64.
3. Because the saved image has identical bytes to the original file, the mod queries Spotlight (`mdfind`) for files of the same size and compares contents with `cmp` to determine the original path. If Spotlight is unavailable, it searches `~/Downloads`, `~/Desktop`, `~/Pictures`, and `~/Documents` using `find`.

## Privacy & Security

No network communication is performed. The mod only reads images in Claude Code's temporary directory and the contents of candidate files with matching sizes (for comparison). It only writes thumbnails placed in `drop-thumb/` inside Claude Code's user-specific temporary directory (`0700`, readable only by the owner). It never writes directly to the shared `/tmp` root. Running `claude plugin validate <directory>` lets you inspect the list of hooked events and invoked APIs.

## Limitations

- Images pasted directly from the clipboard have no original file, so the chip shows `(pasted image)`.
- Because the thumbnail line count is estimated assuming a cell aspect ratio of 0.45, vertical padding may remain depending on your terminal and font.
- When multiple files have identical sizes, the first file whose contents match is treated as the original file.

## Development

```bash
claude plugin validate .   # Inspect configuration and invoked APIs
claude plugin test .       # Run hooks/*.test.ts
tsc -p .                   # Type check after loading once (.claude-plugin/types/ is generated)
```

## Acknowledgements

The approach of "polling the prompt field and using Claude Code's cached image because dropping does not trigger an edit event" was learned from [jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view) (MIT). The code in this repository was written independently and does not include code from that project.

## License

MIT. Full text in `LICENSE`.
