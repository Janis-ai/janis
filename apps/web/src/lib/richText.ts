export interface EmphSeg {
  kind: 'text' | 'bold' | 'italic' | 'strike' | 'code';
  text: string;
}

/** Canonical agent text is markdown-ish. The web surfaces render emphasis
 *  natively; push channels get it translated on egress (formatForChannel in
 *  the API). Emphasis needs non-space content at both ends so "5 * 3 = 15"
 *  and snake_case are untouched. Mirrors the API's CHANNEL_FMT_RE. */
const EM_RE =
  /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*|\*([^\s*](?:[^*]*[^\s*])?)\*|~~([^\s~](?:[^~]*[^\s~])?)~~|`([^`\n]+)`/g;

export function splitEmphasis(text: string): EmphSeg[] {
  const out: EmphSeg[] = [];
  let last = 0;
  for (let m = EM_RE.exec(text); m; m = EM_RE.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const kind = m[1] != null ? 'bold' : m[2] != null ? 'italic' : m[3] != null ? 'strike' : 'code';
    out.push({ kind, text: (m[1] ?? m[2] ?? m[3] ?? m[4]) as string });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export interface RichBlock {
  kind: 'para' | 'list';
  /** para */
  text?: string;
  /** list */
  items?: string[];
  ordered?: boolean;
  /** A blank line precedes this block — render a paragraph gap, not a bare
   *  line break. */
  breakBefore?: boolean;
}

const BULLET_LEAD = /^(?:[-*•])\s+/;
const NUM_LEAD = /^\d+[.)]\s+/;
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
