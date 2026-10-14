const API = 'https://janis-api-696050206949.us-east1.run.app';
const TOKEN = 'dd416836-710e-4be7-806e-b2196669e1c5';
const visitor = 'probe-kofn-' + Date.now();
const j = async (r: Response) => (r.ok ? r.json() : { error: `${r.status} ${await r.text().then((t) => t.slice(0, 80))}` });
const send = async (text: string) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${API}/chat/${TOKEN}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitor, text }),
    });
    if (r.ok) return;
    console.log('send', r.status, (await r.text()).slice(0, 60));
    await new Promise((r2) => setTimeout(r2, 8000));
  }
};
const poll = async () => {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const d = (await j(await fetch(`${API}/chat/${TOKEN}/messages?visitor_id=${visitor}&after=0`))) as any;
    if (!d.messages) { process.stdout.write('.'); continue; }
    const outs = d.messages.filter((m: any) => m.direction === 'out' && (m.payload?.covers_through || m.covers_through));
    if (outs.length >= 2) return outs;
  }
  return [];
};
await send('show me your products');
const outs = await poll();
for (const m of outs) {
  console.log('\nOUT:', (m.text ?? '').slice(0, 140));
  for (const w of m.payload?.widgets ?? m.widgets ?? [])
    console.log('  widget:', w.type, 'items:', w.items?.length, 'total:', w.total);
  console.log('  chips:', JSON.stringify(m.payload?.quick_replies ?? m.quick_replies));
}
