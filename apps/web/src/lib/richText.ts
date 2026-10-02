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
}

const BULLET_LEAD = /^(?:[-*•])\s+/;
const NUM_LEAD = /^\d+[.)]\s+/;
// A bullet marker mid-line: ` * ` followed by **bold**. Requiring the bold
// opener keeps "5 * 3 = 15" and emphasis runs from splitting — models emit
// labelled lists as `* **Title:** … * **Title2:** …` on a single line.
const INLINE_BULLET = / \* (?=\*\*)/g;

/** Split a message into paragraphs and bullet lists. Models emit bullets two
 *  ways — one per line ("* item"), or an inline run on a single line
 *  ("options: * **A** … * **B** …"). Both render as a list; anything else is
 *  a paragraph. */
export function splitBlocks(text: string): RichBlock[] {
  const out: RichBlock[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (items.length) out.push({ kind: 'list', items, ordered });
    items = [];
    ordered = false;
  };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) {
      flush();
      continue;
    }
    if (BULLET_LEAD.test(t) || NUM_LEAD.test(t)) {
      // A numbered list mixing with bullet lines (or vice versa) starts a
      // new list — keep markers consistent within one <ul>/<ol>.
      const isOrdered = NUM_LEAD.test(t);
      if (items.length && isOrdered !== ordered) flush();
      ordered = isOrdered;
      // A bullet line may itself carry more inline bullets after it.
      items.push(...t.replace(BULLET_LEAD, '').replace(NUM_LEAD, '').split(INLINE_BULLET));
      continue;
    }
    const inline = t.match(INLINE_BULLET)?.length ?? 0;
    if (inline >= 2) {
      const [lead, ...bullets] = t.split(INLINE_BULLET);
      flush();
      if (lead.trim()) out.push({ kind: 'para', text: lead.trim() });
      items.push(...bullets);
      continue;
    }
    flush();
    out.push({ kind: 'para', text: t });
  }
  flush();
  return out;
}
