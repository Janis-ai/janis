/** Dependency-free syntax highlighting for the handful of snippets the
 *  console shows (embed tags, identify calls, curl). Produces a flat token
 *  list — CodeBlock wraps each in a themed <span>. */

export interface Tok {
  t?: string; // css class suffix: tok-str, tok-kw, … undefined = plain text
  s: string;
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'await', 'async', 'import',
  'export', 'from', 'new', 'if', 'else', 'for', 'of', 'in', 'while', 'do',
  'typeof', 'instanceof', 'class', 'extends', 'try', 'catch', 'finally',
  'throw', 'switch', 'case', 'default', 'break', 'continue', 'true', 'false',
  'null', 'undefined', 'this', 'void', 'delete', 'yield', 'static',
]);

// comment | string (incl. template) | identifier | number — order wins
const JS_RE =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)/g;

function highlightJs(code: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(JS_RE)) {
    const i = m.index;
    if (i > last) toks.push({ s: code.slice(last, i) });
    const [full, line, , str, word, num] = m;
    if (line || m[2]) toks.push({ t: 'tok-com', s: full });
    else if (str) toks.push({ t: 'tok-str', s: full });
    else if (word) {
      // obj.method → the method reads as a property, not a keyword
      const prev = code.slice(0, i).trimEnd().slice(-1);
      toks.push({
        t: JS_KEYWORDS.has(word) ? 'tok-kw' : prev === '.' ? 'tok-prop' : undefined,
        s: full,
      });
    } else if (num) toks.push({ t: 'tok-num', s: full });
    last = i + full.length;
  }
  if (last < code.length) toks.push({ s: code.slice(last) });
  return toks;
}

// comment | <tag / </tag | attr-name= | "value" / 'value' | > />
const HTML_RE =
  /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w-]*)|([a-zA-Z-]+(?==))|("[^"]*"|'[^']*')/g;

function highlightHtml(code: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(HTML_RE)) {
    const i = m.index;
    if (i > last) toks.push({ s: code.slice(last, i) });
    const [full, com, tag, attr, val] = m;
    if (com) toks.push({ t: 'tok-com', s: full });
    else if (tag) toks.push({ t: 'tok-tag', s: full });
    else if (attr) toks.push({ t: 'tok-attr', s: full });
    else if (val) toks.push({ t: 'tok-str', s: full });
    last = i + full.length;
  }
  if (last < code.length) toks.push({ s: code.slice(last) });
  return toks;
}

// sh: curl snippets — flags and quoted strings pop, rest stays plain
const SH_RE = /('(?:[^']*)'|"(?:[^"]*)")|(-{1,2}[a-zA-Z][\w-]*)/g;

function highlightSh(code: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(SH_RE)) {
    const i = m.index;
    if (i > last) toks.push({ s: code.slice(last, i) });
    const [full, str, flag] = m;
    toks.push({ t: str ? 'tok-str' : flag ? 'tok-attr' : undefined, s: full });
    last = i + full.length;
  }
  if (last < code.length) toks.push({ s: code.slice(last) });
  return toks;
}

export type CodeLang = 'js' | 'html' | 'sh';

export function highlight(code: string, lang: CodeLang): Tok[] {
  if (lang === 'js') return highlightJs(code);
  if (lang === 'html') return highlightHtml(code);
  return highlightSh(code);
}
