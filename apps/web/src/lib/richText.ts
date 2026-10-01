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
