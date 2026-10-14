const API = 'https://app.janis.ai';
const CHANNEL = 'dd416836-710e-4be7-806e-b2196669e1c5';
const vid = `reask${Date.now().toString(36)}x`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seen = new Set<string>();
async function send(text: string) {
  const res = await fetch(`${API}/chat/${CHANNEL}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: vid, text, client_id: `${vid}-${Date.now()}` }) });
  if (!res.ok) throw new Error(`send ${res.status}`);
}
async function reply(since: string): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const { messages } = await (await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`)).json() as any;
    const out = messages.filter((m: any) => m.direction === 'out' && m.text && m.created_at > since && !m.greeting && !seen.has(m.created_at)
      && !/negative sentiment|still working|hang tight|one moment/i.test(m.text)).sort((a: any, b: any) => a.created_at < b.created_at ? -1 : 1);
    const last = out[out.length - 1];
    if (last && !/typing/i.test(last.text)) { seen.add(last.created_at); return last; }
    await delay(2500);
  }
  throw new Error('no reply');
}
async function turn(text: string) {
  const since = new Date(Date.now() - 1000).toISOString();
  await send(text);
  const r = await reply(since);
  const cw = (r.widgets ?? []).find((w: any) => w.type === 'cards');
  const cards = cw?.items ?? [];
  console.log(`\n>>> ${text}\n    text: ${r.text.replace(/\n/g, ' ').slice(0, 200)}\n    cards(${cards.length})${cw?.total ? ` total=${cw.total}` : ''}: ${cards.map((c: any) => c.title).join(' | ') || '(none)'}`);
  return { text: r.text, cards, total: cw?.total };
}
const ok = (c: boolean, m: string) => console.log(`    ${c ? '✓' : '✗'} ${m}`);

const t1 = await turn('show me your products');
ok(t1.cards.length === 10, `10 cards on browse (got ${t1.cards.length})`);
ok(t1.total === 13, `total=13 stamped (got ${t1.total})`);
ok(/10|first|of 13/i.test(t1.text), 'text scopes the count');

const t2 = await turn('any more?');
ok(t2.cards.length === 3, `3 remaining on page 2 (got ${t2.cards.length})`);
ok(!t2.cards.some((c: any) => t1.cards.some((p: any) => p.title === c.title)), 'no repeats from page 1');

const t3 = await turn('show me just the snowboards');
ok(t3.cards.length >= 9, `snowboards render despite all being shown before (got ${t3.cards.length})`);
ok(!t3.cards.some((c: any) => /gift|wax/i.test(c.title)), 'no gift card / wax');

const t4 = await turn('show me again');
ok(t4.cards.length >= 1, `re-ask renders cards (got ${t4.cards.length})`);
