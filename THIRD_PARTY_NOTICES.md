# Third-Party Notices

This repository includes modified icon geometry from the [Lucide](https://lucide.dev/) Cable icon in `site/favicon.svg`, a minimal engagement-icon font subset derived from [JetBrains Mono Nerd Font](https://github.com/ryanoasis/nerd-fonts), and the upstream [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) typeface used to render social preview images.

## JetBrains Mono Nerd Font subset

`site/assets/fonts/engagement-icons.woff2` is a modified WOFF2 subset of JetBrains Mono Nerd Font Regular 3.4.0. It contains only the heart and eye glyphs used by the marketplace engagement UI. The subset is distributed under the SIL Open Font License, Version 1.1. The complete license is included at `site/assets/fonts/engagement-icons.OFL.txt`.

Source: <https://github.com/ryanoasis/nerd-fonts>

## JetBrains Mono

`scripts/og/fonts/JetBrainsMono-Regular.ttf`, `scripts/og/fonts/JetBrainsMono-Bold.ttf`, and `scripts/og/fonts/JetBrainsMono-ExtraBold.ttf` are unmodified JetBrains Mono 2.304 files. They are build-only assets: `scripts/build-og.mjs` renders the generated social preview images with them so the typography matches the marketplace interface on any build machine. They are not served to browsers. The typeface is distributed under the SIL Open Font License, Version 1.1. The complete license is included at `scripts/og/fonts/JetBrainsMono.OFL.txt`.

Source: <https://github.com/JetBrains/JetBrainsMono>

## Lucide

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Source: <https://github.com/lucide-icons/lucide>
