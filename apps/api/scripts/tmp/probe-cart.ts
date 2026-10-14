const API = 'https://app.janis.ai';
const CHANNEL = 'dd416836-710e-4be7-806e-b2196669e1c5';
const vid = `cart${Date.now().toString(36)}x`;
const res = await fetch(`${API}/chat/${CHANNEL}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    visitor_id: vid,
    text: 'I just added The Videographer Snowboard to my cart.',
    client_id: `${vid}-${Date.now()}`,
    tap: true,
    tap_of: 'The Videographer Snowboard — add to cart',
  }),
});
console.log('send:', res.status);
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  await new Promise((r) => setTimeout(r, 2500));
  const m = await fetch(`${API}/chat/${CHANNEL}/messages?visitor_id=${vid}`);
  const { messages } = (await m.json()) as { messages: any[] };
  const out = messages.filter((x) => x.direction === 'out' && x.text && !x.greeting
    && !/still working|hang tight|one moment|typing/i.test(x.text ?? ''));
  const last = out[out.length - 1];
  if (last) {
    console.log('TEXT:', last.text.slice(0, 300));
    console.log('WIDGETS:', JSON.stringify((last.widgets ?? []).map((w: any) => w.type)));
    break;
  }
}
process.exit(0);
