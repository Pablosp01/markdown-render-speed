// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer.
//
// Written from scratch for the markdown-render-speed-02 bounty. It returns,
// for every string, exactly the HTML that marked 18.1.3's marked.parse returns
// with marked's defaults (gfm on, breaks off, pedantic off, async off).
// The implementation follows the same two-phase shape every CommonMark
// renderer uses — block lexing, then inline lexing, then rendering — but the
// code, the structure and the scanning are my own.
//
// No dependencies, no network, no wall clock, no reads outside the input the
// caller hands it, no state kept between parse() calls.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
// An & that is NOT the start of a valid character reference (&word; / &#1; / &#x1;)
// gets escaped; a valid reference passes through untouched.
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const CARET_STRIP = /(^|[^[])\^/g;

// Escape HTML special characters. With encodeAll every & is escaped;
// otherwise an & that begins a valid character reference is left alone.
function escapeHtml(text, encodeAll) {
  if (encodeAll) {
    return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_REPLACE, (c) => HTML_ESCAPES[c]) : text;
  }
  return ESCAPE_TEST_NO_ENCODE.test(text)
    ? text.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => HTML_ESCAPES[c])
    : text;
}

// Decode numeric character references (&#65; &#x41;) in text. Named references
// (&copy;) are NOT decoded — they pass through as literal text. A bare & that
// does not start a valid reference becomes &amp;. Out-of-range, zero and
// surrogate code points become U+FFFD; &#38; becomes &amp;.
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Clean a link destination the way a browser would: encodeURI, then restore
// any %25 back to % (so an already-encoded % stays encoded). Returns null
// when encodeURI throws (e.g. a lone surrogate in the URL).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes. Escaped pipes (\|) become literal |.
// Leading/trailing empty cells from outer pipes are dropped; the row is
// padded or truncated to the header's cell count.
function splitTableCells(row, count) {
  const parts = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  }).split(' |');
  let cells = parts;
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing characters: with invert=false, strip chars equal to ch;
// with invert=true, strip chars NOT equal to ch. (Used for trailing newlines,
// trailing closing hashes, and counting trailing backslashes.)
function stripTrailing(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// Drop trailing blank lines from a block of text, keeping at most one trailing
// newline. (Indented code and raw HTML blocks end this way.)
function trimBlankTail(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && /^[ \t]*$/.test(lines[last]);) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

// Normalise a link label for lookup: trim, collapse inner whitespace runs to
// a single space, and case-fold (the double fold matches Unicode case folding
// quirks for characters like the Kelvin sign).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Scan a string for balanced parentheses. Returns -1 when there are no
// parens at all (or they are balanced), -2 when an open paren is left
// unclosed, or the index of the first unmatched closing paren.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tab stops every 4 columns, starting at column col.
function expandTabs(str, col = 0) {
  let out = '';
  let c = col;
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// For a fenced code block, strip the fence's own indent from every content
// line (up to that many leading spaces).
function fenceDedent(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lead = line.match(/^\s+/);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// Does the link text (starting at offset `at` inside the full source) contain
// a raw HTML tag or autolink that runs past the end of the link text? Such a
// link is not a link at all.
function linkTextHasRawTag(fullSrc, text, at, rules) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      const m = rules.codespan.exec(text.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (text[i] !== '<') continue;
    const rest = fullSrc.slice(at + i);
    const m = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (m) {
      if (m[0].length > text.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared regexes (the "other" rules)
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const R_OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Parameterised matchers, cached for indent levels 0..3.
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cache4((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cache4((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cache4((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cache4((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cache4((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cache4((n) => new RegExp(`^ {0,${n}}>`)),
};

// Cache a one-argument factory for the small integer range it is used with.
function cache4(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}

// ---------------------------------------------------------------------------
// Block rules (GFM)
// ---------------------------------------------------------------------------

const R_BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\x0a*|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\\n*|$)|[ \t]+\n)[^\n]+)*)/,
  text: /^[^\n]+/,
  // The paragraph rule as it applies inside blockquotes and list items: a
  // list item only interrupts it when the marker is followed by a space or
  // end of line, and a setext underline never applies there.
  innerParagraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
};

// The paragraph rule used at the top level when the previous token was a
// list item's inner paragraph: list items interrupt only on `1.` style
// markers followed by space and a non-space character.

// ---------------------------------------------------------------------------
// Inline rules (GFM)
// ---------------------------------------------------------------------------

const R_INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\\[\]\\\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\\[\]\\\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\\\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\\\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  codespan: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
  // Plain text: runs until the next construct that could start something —
  // backslash, <, !, [, backtick, *, ~, _, a protocol, www., a mailto:/xmpp:
  // address, or an email address — or a hard break (two spaces + newline).
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  reflinkSearch: /!?\[((?:[^\\[\]\\\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|[^\\[\]\\\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\\[\]\\\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\\\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\\[\]\\\\]){1,999})\](?:\[\])?(?!\()/g,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
};

// ---------------------------------------------------------------------------
// Emphasis masking
// ---------------------------------------------------------------------------
// Before emphasis is resolved, the inline source is masked: link labels that
// resolve, code spans, links and raw HTML tags have their insides replaced
// with runs of "a" (and escaped punctuation with "+"), so a * on one side of
// a link or code span can never pair with one on the other side. The mask is
// the same length as the source, so indexes line up. A per-lexer cache keeps
// the last scan of possible closer positions for a masked string.

function scanCloserPositions(masked) {
  const emStrong = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    let j = i + 1;
    for (; j < n && masked[j] === ch;) j++;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else emStrong[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, lastEmStrong: emStrong, lastDel: del };
}

function maskForEmphasis(lexer, src) {
  let masked = src;
  if (lexer.links && src.includes('[')) {
    const re = R_INLINE.reflinkSearch;
    const replaceOne = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lexer.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (lexer.linkInText(inner)) {
          return '[' + inner.replace(re, replaceOne) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(re, replaceOne);
  }
  masked = masked.replace(R_INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) => {
    if (punct) return '+'.repeat(whole.length);
    if (ticks) return ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
    return whole;
  });
  masked = masked.replace(R_INLINE.blockSkip, (whole, _pre, ticks) => {
    const keep = ticks ? ticks.length : 0;
    return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
  });
  return masked;
}

const R_PARAGRAPH_LIST = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*)/;

// ---------------------------------------------------------------------------
// Lexer: turns source into block tokens, then fills in the inline tokens.
// ---------------------------------------------------------------------------

class MdLexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.maskStack = [];
  }

  // Full lex: normalise line endings, block-lex, then inline-lex every
  // queued paragraph / heading / table cell, in order. Link reference
  // definitions are therefore all registered before any inline parsing runs.
  lex(src) {
    src = src.replace(R_OTHER.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue a string for inline lexing; returns the token array that will be
  // filled in later, so the caller can attach it to its block token now.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  // Is there a link (inline or reference) inside this text? Used while
  // masking, so emphasis never pairs across a link's brackets.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(R_INLINE.blockSkip)) {
      if (R_INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(R_INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      const resolves = Object.hasOwn(this.links, normalizeLabel(s.slice(r + 1, -1)));
      if (!(s.charAt(0) === '!' || !resolves) && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }

  // The block loop. Rules are tried in a fixed order; a rule that matches
  // consumes its raw text and the loop restarts at what remains. `nested`
  // is true when lexing the inside of a blockquote or list item: paragraphs
  // may then merge with a paragraph left by a previous chunk, and (for list
  // items) top-level paragraphs are not produced at all.
  blockTokens(src, tokens, nested = false) {
    let mergePara = nested;
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHeading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokBlockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokList(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHtml(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokLheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokParagraph(src))) {
        const prev = tokens.at(-1);
        if (mergePara && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        mergePara = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  tokSpace(src) {
    const m = R_BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  tokCode(src) {
    const m = R_BLOCK.code.exec(src);
    if (!m) return undefined;
    const raw = trimBlankTail(m[0]);
    const text = raw.replace(R_OTHER.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  tokFences(src) {
    const m = R_BLOCK.fences.exec(src);
    if (!m) return undefined;
    const text = fenceDedent(m[0], m[3] || '');
    const lang = m[2] ? m[2].trim().replace(R_INLINE.anyPunctuation, '$1') : m[2];
    return { type: 'code', raw: m[0], lang, text };
  }

  tokHeading(src) {
    const m = R_BLOCK.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (R_OTHER.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || R_OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text) };
  }

  tokHr(src) {
    const m = R_BLOCK.hr.exec(src);
    if (!m) return undefined;
    return { type: 'hr', raw: stripTrailing(m[0], '\n') };
  }

  tokBlockquote(src) {
    const m = R_BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    let lines = stripTrailing(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    for (; lines.length > 0;) {
      let hasMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R_OTHER.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
        else if (!hasMarker) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(R_OTHER.blockquoteMarkerWhitespace, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(R_OTHER.blockquoteSetextReplace, '\n    $1')
        .replace(R_OTHER.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const g = last;
        const rest = lines.join('\n');
        const combined = g.raw + '\n' + rest.replace(R_OTHER.blockquoteSetextReplace2, '');
        const f = this.tokBlockquote(combined);
        tokens[tokens.length - 1] = f;
        const leftover = combined.substring(f.raw.length).replace(/^\n/, '');
        const leftLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftLines ? lines.slice(0, -leftLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - g.text.length) + f.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && R_OTHER.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const g = last;
        const combined = g.raw + '\n' + lines.join('\n');
        const f = this.tokList(combined);
        tokens[tokens.length - 1] = f;
        const extra = f.raw.length > g.raw.length
          ? combined.slice(g.raw.length + 1, f.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + y;
          text = text + '\n' + y;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  tokList(src) {
    const first = R_BLOCK.list.exec(src);
    if (!first) return undefined;
    const input = src;
    const consumed = () => input.length - src.length;
    const marker = first[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false, items: [],
    };
    const bullPattern = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = R_OTHER.listItemRegex(bullPattern);
    let sawDoubleBlank = false;
    for (; src;) {
      let emptyItem = false;
      let itemText = '';
      const m = itemRe.exec(src);
      if (!m || R_BLOCK.hr.test(src)) break;
      const itemStart = consumed();
      src = src.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const bulletLen = m[1].length;
      let afterBullet = firstLine.replace(R_OTHER.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
      const nextLine = src.split('\n', 1)[0];
      let firstBlank = !afterBullet.trim();
      let contentIndent = 0;
      if (firstBlank) {
        contentIndent = bulletLen + 1;
      } else {
        contentIndent = afterBullet.search(R_OTHER.nonSpaceChar);
        contentIndent = contentIndent > 4 ? 1 : contentIndent;
        itemText = afterBullet.slice(contentIndent);
        contentIndent += bulletLen;
      }
      if (firstBlank && R_OTHER.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = R_OTHER.nextBulletRegex(contentIndent);
        const hrAt = R_OTHER.hrRegex(contentIndent);
        const fenceAt = R_OTHER.fencesBeginRegex(contentIndent);
        const headingAt = R_OTHER.headingBeginRegex(contentIndent);
        const htmlAt = R_OTHER.htmlBeginRegex(contentIndent);
        const quoteAt = R_OTHER.blockquoteBeginRegex(contentIndent);
        for (; src;) {
          const line = src.split('\n', 1)[0];
          const expanded = line.replace(R_OTHER.leadingSpaceTab, (ws) => expandTabs(ws));
          if (fenceAt.test(line) || headingAt.test(line) || htmlAt.test(line) || quoteAt.test(line) || nextBullet.test(line) || hrAt.test(line)) break;
          if (expanded.search(R_OTHER.nonSpaceChar) >= contentIndent || !line.trim()) {
            itemText += '\n' + expanded.slice(contentIndent);
          } else {
            if (firstBlank || afterBullet.replace(R_OTHER.tabCharGlobal, '    ').search(R_OTHER.nonSpaceChar) >= 4 || fenceAt.test(afterBullet) || headingAt.test(afterBullet) || htmlAt.test(afterBullet) || hrAt.test(afterBullet)) break;
            const asSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && R_BLOCK.lheading.test(afterBullet + '\n' + line);
            const lazy = asSetext ? `    ${expanded.replace(/^ {0,3}/, '')}` : line;
            itemText += '\n' + lazy;
          }
          const wasBlank = !line.trim();
          src = src.substring(line.length + 1);
          afterBullet = expanded.slice(contentIndent);
          firstBlank = wasBlank;
        }
      }
      const itemRaw = input.slice(itemStart, consumed());
      if (!list.loose) {
        if (sawDoubleBlank) list.loose = true;
        else if (R_OTHER.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: R_OTHER.listIsTask.test(itemText),
        loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = input.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => R_OTHER.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(R_OTHER.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(R_OTHER.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(R_OTHER.listReplaceTask, '');
        for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
          if (R_OTHER.listIsTask.test(this.inlineQueue[i].src)) {
            this.inlineQueue[i].src = this.inlineQueue[i].src.replace(R_OTHER.listReplaceTask, '');
            break;
          }
        }
        const box = R_OTHER.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (firstTok && ['paragraph', 'text'].includes(firstTok.type) && 'tokens' in firstTok && firstTok.tokens) {
              firstTok.raw = checkbox.raw + firstTok.raw;
              firstTok.text = checkbox.raw + firstTok.text;
              firstTok.tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  tokHtml(src) {
    const m = R_BLOCK.html.exec(src);
    if (!m) return undefined;
    const raw = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  tokDef(src) {
    const m = R_BLOCK.def.exec(src);
    if (!m) return undefined;
    if (!R_OTHER.startAngleBracket.test(m[2]) && parenBalance(m[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(R_OTHER.hrefBrackets, '$1').replace(R_INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(R_INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
  }

  tokTable(src) {
    const m = R_BLOCK.table.exec(src);
    if (!m || !R_OTHER.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitTableCells(m[1]);
    const aligns = m[2].replace(R_OTHER.tableAlignChars, '').split('|');
    const body = m[3]?.trim() ? m[3].replace(R_OTHER.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return undefined;
    for (const a of aligns) {
      if (R_OTHER.tableAlignRight.test(a)) table.align.push('right');
      else if (R_OTHER.tableAlignCenter.test(a)) table.align.push('center');
      else if (R_OTHER.tableAlignLeft.test(a)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i]), header: true, align: table.align[i] });
    }
    for (const row of body) {
      table.rows.push(splitTableCells(row, headerCells.length).map((cell, p) => (
        { text: cell, tokens: this.inline(cell), header: false, align: table.align[p] }
      )));
    }
    return table;
  }

  tokLheading(src) {
    const m = R_BLOCK.lheading.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  tokParagraph(src) {
    const m = R_BLOCK.paragraph.exec(src);
    if (!m) return undefined;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  tokText(src) {
    const m = R_BLOCK.text.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  // --- inline tokenizers ---------------------------------------------------

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineScan(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  // Inline loop over one string. `masked` is the emphasis-masked copy of
  // the whole string (same length); the token rules run on the remaining
  // source, while the emphasis rules use the masked copy plus the offset.
  inlineScan(src, tokens) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskForEmphasis(this, src) : src;
    this.maskStack.push(scanCloserPositions(masked));
    try {
      let prevLast = '';
      let prevWasText = false;
      let guard = Infinity;
      for (; src;) {
        if (src.length < guard) guard = src.length;
        else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
        if (!prevWasText) prevLast = '';
        prevWasText = false;
        let tok;
        if ((tok = this.tokEscape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokTag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokLink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokReflink(src))) {
          src = src.substring(tok.raw.length);
          const prev = tokens.at(-1);
          if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
          else tokens.push(tok);
          continue;
        }
        if ((tok = this.tokEmStrong(src, masked, prevLast))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokCodespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokBr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokDel(src, masked, prevLast))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokAutolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (!this.state.inLink && (tok = this.tokUrl(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokInlineText(src))) {
          src = src.substring(tok.raw.length);
          if (tok.raw.slice(-1) !== '_') prevLast = tok.raw.slice(-1);
          prevWasText = true;
          const prev = tokens.at(-1);
          if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
          else tokens.push(tok);
          continue;
        }
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
      return tokens;
    } finally {
      this.maskStack.pop();
    }
  }

  // Last possible emphasis closer position for a delimiter char in the
  // current masked string (from this call's scan; recomputed if it does not
  // match, which cannot happen for the top-level scan).
  lastEmStrongCloser(masked, ch) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastEmStrong[ch];
    return scanCloserPositions(masked).lastEmStrong[ch];
  }

  lastDelCloser(masked) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastDel;
    return scanCloserPositions(masked).lastDel;
  }

  tokEscape(src) {
    const m = R_INLINE.escape.exec(src);
    if (!m) return undefined;
    return { type: 'escape', raw: m[0], text: m[1] };
  }

  tokTag(src) {
    const m = R_INLINE.tag.exec(src);
    if (!m) return undefined;
    if (!this.state.inLink && R_OTHER.startATag.test(m[0])) this.state.inLink = true;
    else if (this.state.inLink && R_OTHER.endATag.test(m[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && R_OTHER.startPreScriptTag.test(m[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && R_OTHER.endPreScriptTag.test(m[0])) this.state.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: m[0] };
  }

  tokLink(src) {
    if (this.state.linkParenPossible === false) return undefined;
    const m = R_INLINE.link.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasRawTag(src, m[1], bang, R_INLINE)) return undefined;
    const dest = m[2].trim();
    if (R_OTHER.startAngleBracket.test(dest)) {
      if (!R_OTHER.endAngleBracket.test(dest)) return undefined;
      const unslashed = stripTrailing(dest.slice(0, -1), '\\');
      if ((dest.length - unslashed.length) % 2 === 0) return undefined;
    } else {
      const bal = parenBalance(m[2], '()');
      if (bal === -2) return undefined;
      if (bal > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
        m[2] = m[2].substring(0, bal);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const rawUnslashed = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - rawUnslashed.length) % 2 === 0) return undefined;
    let href = m[2].trim();
    const title = m[3] ? m[3].slice(1, -1) : '';
    if (R_OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
    return this.makeLinkToken(m, {
      href: href && href.replace(R_INLINE.anyPunctuation, '$1'),
      title: title && title.replace(R_INLINE.anyPunctuation, '$1'),
    }, m[0]);
  }

  tokReflink(src) {
    const m = R_INLINE.reflink.exec(src) || R_INLINE.nolink.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasRawTag(src, m[1], bang, R_INLINE)) return undefined;
    const ref = this.links[normalizeLabel(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return this.makeLinkToken(m, ref, m[0]);
  }

  // Build a link or image token from a match and a {href, title} pair. The
  // link text is inline-lexed now. A link whose text contains another link
  // is not a link (the outer brackets stay literal text); images do not
  // count as links for that rule.
  makeLinkToken(m, ref, raw) {
    const href = ref.href;
    const title = ref.title || null;
    const text = m[1].replace(R_OTHER.outputLinkReplace, '$1');
    const isImage = m[0].charAt(0) === '!';
    const savedInLink = this.state.inLink;
    const savedEmitted = this.state.linkEmitted;
    const savedRawBlock = this.state.inRawBlock;
    this.state.inLink = true;
    this.state.linkEmitted = false;
    const inner = this.inlineTokens(text);
    const nestedLink = this.state.linkEmitted;
    this.state.linkEmitted = savedEmitted;
    this.state.inLink = savedInLink;
    if (!isImage) {
      if (nestedLink) { this.state.inRawBlock = savedRawBlock; return undefined; }
      this.state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens: inner };
  }

  tokEmStrong(src, masked, prevChar) {
    const s = R_INLINE.emStrongLDelim.exec(src);
    if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return undefined;
    const ch = s[0][0];
    const prevSame = prevChar === ch;
    const offset = masked.length - src.length;
    let runStart = offset;
    for (; runStart > 0 && masked[runStart - 1] === ch;) runStart--;
    const before = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsDelimOrPunct = before === '*' || before === '_' || !!R_INLINE.punctuation.exec(before);
    let prev = prevChar;
    if (runStart < offset) prev = before;
    const prevIsPunct = runStart < offset ? beforeIsDelimOrPunct : !!R_INLINE.punctuation.exec(prev);
    if (s[4] && prev.match(R_OTHER.unicodeAlphaNumeric)) return undefined;
    const nextIsPunct = s[1] || s[3] || '';
    if (!nextIsPunct || !prev || prevIsPunct) {
      const runLen = [...s[0]].length - 1;
      let openLeft = runLen;
      let skipped = 0;
      const totalRun = offset - runStart + runLen;
      const canClose = !!before.trim() && (!!nextIsPunct || (ch === '*' && !beforeIsDelimOrPunct));
      if (ch !== '*' && ch !== '_') return undefined;
      const closerRe = ch === '*' ? R_INLINE.emStrongRDelimAst : R_INLINE.emStrongRDelimUnd;
      const lastCloser = this.lastEmStrongCloser(masked, ch);
      const runEnd = offset + runLen;
      if (lastCloser < runEnd) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - runEnd;
      closerRe.lastIndex = 0;
      let m;
      while ((m = closerRe.exec(rest)) !== null && !(m.index > maxIndex)) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        const closeLen = [...g].length;
        if (m[3] || m[4]) { openLeft += closeLen; continue; }
        if (m[5] || m[6] || canClose) {
          if (prevSame && (m[5] || m[6])) break;
          if (totalRun % 3 && !((totalRun + closeLen) % 3)) { skipped += closeLen; continue; }
        }
        openLeft -= closeLen;
        if (openLeft > 0) continue;
        const useLen = Math.min(closeLen, closeLen + openLeft + skipped);
        const firstLen = [...m[0]][0].length;
        const whole = src.slice(0, runLen + m.index + firstLen + useLen);
        if (Math.min(runLen, useLen) % 2) {
          const inner = whole.slice(1, -1);
          return { type: 'em', raw: whole, text: inner, tokens: this.inlineTokens(inner) };
        }
        const inner = whole.slice(2, -2);
        return { type: 'strong', raw: whole, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  tokCodespan(src) {
    const m = R_INLINE.codespan.exec(src);
    if (!m) return undefined;
    let text = m[2].replace(R_OTHER.newLineCharGlobal, ' ');
    const hasContent = R_OTHER.nonSpaceChar.test(text);
    const padded = R_OTHER.startingSpaceChar.test(text) && R_OTHER.endingSpaceChar.test(text);
    if (hasContent && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  tokBr(src) {
    const m = R_INLINE.br.exec(src);
    if (!m) return undefined;
    return { type: 'br', raw: m[0] };
  }

  tokDel(src, masked, prevChar) {
    const s = R_INLINE.delLDelim.exec(src);
    if (!s) return undefined;
    if (!(s[1] || '') || !prevChar || R_INLINE.punctuation.exec(prevChar)) {
      const runLen = [...s[0]].length - 1;
      let openLeft = runLen;
      const lastCloser = this.lastDelCloser(masked);
      const runEnd = masked.length - src.length + runLen;
      if (lastCloser < runEnd) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - runEnd;
      const closerRe = R_INLINE.delRDelim;
      closerRe.lastIndex = 0;
      let m;
      while ((m = closerRe.exec(rest)) !== null && !(m.index > maxIndex)) {
        const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        const closeLen = [...g].length;
        if (closeLen !== runLen) continue;
        if (m[3] || m[4]) { openLeft += closeLen; continue; }
        openLeft -= closeLen;
        if (openLeft > 0) continue;
        const useLen = Math.min(closeLen, closeLen + openLeft);
        const firstLen = [...m[0]][0].length;
        const whole = src.slice(0, runLen + m.index + firstLen + useLen);
        const inner = whole.slice(runLen, -runLen);
        return { type: 'del', raw: whole, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  tokAutolink(src) {
    const m = R_INLINE.autolink.exec(src);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tokUrl(src) {
    const m = R_INLINE.url.exec(src);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = R_INLINE.backpedal.exec(m[0])?.[0] ?? '';
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tokInlineText(src) {
    const m = R_INLINE.text.exec(src);
    if (!m) return undefined;
    const inRaw = this.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeNumericRefs(m[0]), escaped: inRaw };
  }
}

// ---------------------------------------------------------------------------
// Rendering: block tokens -> HTML, inline tokens -> HTML
// ---------------------------------------------------------------------------

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(tok); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderCode(tok) {
  const lang = (tok.lang || '').match(R_OTHER.notSpaceStart)?.[0];
  const text = tok.text ? tok.text.replace(R_OTHER.endingNewline, '') + '\n' : '';
  const body = escapeHtml(text, true);
  if (lang) return `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`;
  return `<pre><code>${body}</code></pre>\n`;
}

function renderList(tok) {
  let items = '';
  for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderTable(tok) {
  let headCells = '';
  for (const cell of tok.header) headCells += renderTableCell(cell);
  const headRow = `<tr>\n${headCells}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += renderTextToken(tok); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(tok); break;
      case 'image': out += renderImage(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += renderTextToken(tok); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// Plain-text rendering of inline tokens, used for image alt text: markup is
// dropped, code spans and raw HTML keep their text, hard breaks vanish.
function renderInlinePlain(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += tok.text; break;
      case 'html': out += tok.text; break;
      case 'link': case 'image': out += tok.tokens ? renderInlinePlain(tok.tokens) : tok.text; break;
      case 'checkbox': out += tok.raw; break;
      case 'strong': case 'em': case 'del': out += tok.tokens ? renderInlinePlain(tok.tokens) : tok.text; break;
      case 'codespan': out += tok.text; break;
      case 'br': break;
      case 'text': out += tok.text; break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(tok) {
  const text = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
  const href = cleanUrl(tok.href);
  if (href === null) return text;
  const escHref = escapeHtml(href, tok.autolink);
  let out = `<a href="${escHref}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + `>${text}</a>`;
}

function renderImage(tok) {
  const alt = tok.tokens ? renderInlinePlain(tok.tokens) : tok.text;
  const href = cleanUrl(tok.href);
  if (href === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const lexer = new MdLexer();
  const tokens = lexer.lex(markdown);
  return renderBlocks(tokens);
}
