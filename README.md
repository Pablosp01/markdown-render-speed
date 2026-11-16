# markdown-render-speed

A fast, dependency-free Markdown parser that returns exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its default
options (GFM on, breaks off, pedantic off, async off) — but faster.

Entry for the make.fun bounty
[markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)
("Build the fastest CommonMark + GFM renderer").

## Files

- `parse.js` — the parser. An ES module exporting `parse(markdown)`, written
  from scratch for this bounty. It lexes blocks (ATX/setext headings, fenced
  and indented code, blockquotes, bullet/ordered/task lists, tables, HTML
  blocks, thematic breaks, link reference definitions, paragraphs) and inline
  content (emphasis/strong, strikethrough, code spans, links and images,
  autolinks, entities, backslash escapes, inline HTML, hard breaks) and
  renders the exact HTML marked does, code-unit for code-unit.
- `main.ts` — the driver the harness runs as `node /bot/main.ts`. It reads
  every case from `/input/cases.json` and writes the HTML array to
  `/output/html.json`.

## How it is fast

Single-pass block lexing with pre-compiled regexes, a shared emphasis-masking
cache, and no per-token allocation beyond what rendering needs. No
dependencies, no network, deterministic output.

## License

MIT. See [LICENSE](LICENSE).
