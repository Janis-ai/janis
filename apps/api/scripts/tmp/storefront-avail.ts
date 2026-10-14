const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
for (const handle of ['the-compare-at-price-snowboard', 'the-videographer-snowboard']) {
  const pj = await fetch(`https://torontofood.myshopify.com/products/${handle}.js`, {
    headers: { accept: 'application/json', cookie }, redirect: 'manual' });
  if (!pj.ok) { console.log(handle, '→', pj.status); continue; }
  const p = await pj.json() as { title: string; available: boolean; variants: { id: number; title: string; available: boolean }[] };
  console.log(p.title, '| product avail:', p.available, '| variants:', p.variants.map(v => `${v.id}:${v.available}`).join(' '));
}
