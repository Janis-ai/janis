import { MATH_SRC, latexToUnicode, mathToUnicode, cleanMathNoise } from '@janis/shared';

export interface EmphSeg {
  kind: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'math';
  text: string;
}

/** Canonical agent text is markdown-ish plus LaTeX-ish math ($…$, $$…$$,
 *  \(…\), \[…\]). The web surfaces render it natively; push channels get it
 *  translated on egress (formatForChannel in the API). One combined pass so
 *  ordering is leftmost-match: math tried first at each position keeps the
 *  * inside $a*b$ from pairing as italic, while **$x^2$** still works —
 *  emphasis that wraps math is detexed inside the emphasis tag (code keeps
 *  its literal source). Emphasis needs non-space content at both ends so
 *  "5 * 3 = 15" and snake_case are untouched. Mirrors the API's
 *  CHANNEL_FMT_RE + shared's MATH_SRC. */
const SEG_RE = new RegExp(
  `${MATH_SRC}|\\*\\*([^\\s*](?:[^*]*[^\\s*])?)\\*\\*|\\*([^\\s*](?:[^*]*[^\\s*])?)\\*|~~([^\\s~](?:[^~]*[^\\s~])?)~~|\`([^\`\\n]+)\``,
  'g',
);

export function splitEmphasis(text: string): EmphSeg[] {
  const out: EmphSeg[] = [];
  let last = 0;
  SEG_RE.lastIndex = 0;
  for (let m = SEG_RE.exec(text); m; m = SEG_RE.exec(text)) {
    if (m.index > last)
      out.push({ kind: 'text', text: cleanMathNoise(text.slice(last, m.index)) });
    const body = m[1] ?? m[2] ?? m[3] ?? m[4]; // MATH_SRC capture groups
    if (body != null) {
      const d = latexToUnicode(body.trim()).trim();
      out.push({ kind: 'math', text: d || m[0] });
    } else {
      const kind =
        m[5] != null ? 'bold' : m[6] != null ? 'italic' : m[7] != null ? 'strike' : 'code';
      let inner = (m[5] ?? m[6] ?? m[7] ?? m[8]) as string;
      if (kind !== 'code') inner = mathToUnicode(inner);
      out.push({ kind, text: inner });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length)
    out.push({ kind: 'text', text: cleanMathNoise(text.slice(last)) });
  return out;
}

/** Paired emphasis markers become segments; a marker left in a 'text'
 *  segment is unpaired — either literal ("**" typed as such) or a preview
 *  truncated mid-pair. Previews strip the strays so a cut doesn't leak
 *  half a marker. Single * and _ survive ("5 * 3", snake_case). */
export const stripStrayMarkers = (s: string) => s.replace(/\*\*|~~|`/g, '');

/** Plain string with emphasis markers stripped — for contexts that can't
 *  take elements (palette hints, title attributes, aria labels). */
export function plainText(text: string): string {
  return splitEmphasis(text)
    .map((s) => (s.kind === 'text' ? stripStrayMarkers(s.text) : s.text))
    .join('');
}

export interface LinkSeg {
  label: string;
  href: string;
}

/** Sentence punctuation glued to a URL — "see https://x.com/a." should link
 *  the URL, not the period. Closers are only stripped when unbalanced, so
 *  https://x.com/f_(b) keeps its parens while "(see https://x.com)" doesn't
 *  eat the bracket. Returns [cleanUrl, trailingText]. */
function splitTrail(u: string): [string, string] {
  let trail = '';
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (u.length) {
    const c = u[u.length - 1];
    if ('.,;:!?\'"'.includes(c)) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    const open = pairs[c];
    if (open && u.split(c).length - 1 > u.split(open).length - 1) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return [u, trail];
}

/** Render [label](url) markdown links and bare https:// URLs as link
 *  segments — the caller renders the anchors (widget, chat, inbox each
 *  style them differently). DOM-only upstream so text can't inject markup. */
export function linkifyParts(text: string): (string | LinkSeg)[] {
  const parts: (string | LinkSeg)[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [href, trail] = splitTrail(m[2] ?? m[3]!);
    if (!href) {
      parts.push(m[0]); // nothing left after trimming — emit the raw match
    } else {
      parts.push({ label: m[1] ?? href, href });
      if (trail) parts.push(trail);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export interface RichBlock {
  kind: 'para' | 'list' | 'heading';
  /** para, heading */
  text?: string;
  /** heading — markdown depth 1-6 */
  level?: number;
  /** list */
  items?: string[];
  ordered?: boolean;
  /** A blank line precedes this block — render a paragraph gap, not a bare
   *  line break. */
  breakBefore?: boolean;
}

const BULLET_LEAD = /^(?:[-*•])\s+/;
const NUM_LEAD = /^\d+[.)]\s+/;
const HEAD_LEAD = /^(#{1,6})\s+/;
// A bullet marker mid-line: ` * ` or ` - ` followed by **bold**. Requiring
// the bold opener keeps "5 * 3 = 15", prose dashes and emphasis runs from
// splitting — models emit labelled lists as `* **Title:** … * **Title2:** …`
// (or the `- **Title:**` variant) on a single line.
const INLINE_BULLET = / (?:(?:[*-])|(?:\d+[.)])) (?=\*\*)/g;

/** Split a message into paragraphs and bullet lists. Models emit bullets two
 *  ways — one per line ("* item"), or an inline run on a single line
 *  ("options: * **A** … * **B** …"). Both render as a list; anything else is
 *  a paragraph. */
/** Trailing prose glues onto the last item of a stored list ("- **API:** …
 *  HTTP. All channels share… today?"). When every earlier item is a single
 *  sentence, extras on the last are post-list prose — return them so the
 *  caller can emit a following paragraph. Mutates items. */
function detachTail(items: string[]): string | null {
  if (items.length < 2) return null;
  const sents = (s: string) =>
    s.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);
  const last = sents(items[items.length - 1] ?? '');
  if (last.length < 2) return null;
  if (!items.slice(0, -1).every((i) => sents(i).length <= 1)) return null;
  items[items.length - 1] = last[0] ?? '';
  return last.slice(1).join(' ');
}

export function splitBlocks(text: string): RichBlock[] {
  const out: RichBlock[] = [];
  let items: string[] = [];
  let ordered = false;
  // Blank lines are paragraph breaks — remember them so renderers can show
  // a real gap instead of concatenating blocks inline (".You'll").
  let gapNext = false;
  let listGap = false;
  const flush = () => {
    if (items.length) {
      const tail = detachTail(items);
      const list: RichBlock = { kind: 'list', items, ordered };
      if (listGap) list.breakBefore = true;
      out.push(list);
      if (tail) out.push({ kind: 'para', text: tail });
    }
    items = [];
    ordered = false;
    listGap = false;
  };
  const pushPara = (t: string) => {
    const b: RichBlock = { kind: 'para', text: t };
    if (gapNext) b.breakBefore = true;
    gapNext = false;
    out.push(b);
  };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) {
      flush();
      if (out.length) gapNext = true;
      continue;
    }
    const head = HEAD_LEAD.exec(t);
    if (head) {
      flush();
      const b: RichBlock = {
        kind: 'heading',
        level: head[1].length,
        text: t.replace(HEAD_LEAD, '').replace(/\s*#+\s*$/, ''),
      };
      if (gapNext) b.breakBefore = true;
      gapNext = false;
      out.push(b);
      continue;
    }
    if (BULLET_LEAD.test(t) || NUM_LEAD.test(t)) {
      // A numbered list mixing with bullet lines (or vice versa) starts a
      // new list — keep markers consistent within one <ul>/<ol>.
      const isOrdered = NUM_LEAD.test(t);
      if (items.length && isOrdered !== ordered) flush();
      if (!items.length) {
        listGap = gapNext;
        gapNext = false;
      }
      ordered = isOrdered;
      // A bullet line may itself carry more inline bullets after it.
      items.push(...t.replace(BULLET_LEAD, '').replace(NUM_LEAD, '').split(INLINE_BULLET));
      continue;
    }
    const inlineMarks = t.match(INLINE_BULLET) ?? [];
    if (inlineMarks.length >= 2) {
      const [lead, ...bullets] = t.split(INLINE_BULLET);
      flush();
      if (lead.trim()) pushPara(lead.trim());
      if (!items.length) {
        listGap = gapNext;
        gapNext = false;
      }
      ordered = /\d/.test(inlineMarks[0] ?? '');
      items.push(...bullets);
      continue;
    }
    flush();
    pushPara(t);
  }
  flush();
  return out;
}
