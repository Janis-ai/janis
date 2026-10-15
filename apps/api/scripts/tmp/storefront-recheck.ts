const pw = 'skatwo';
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
let cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const loc = res.headers.get('location');
if (loc) {
  const f = await fetch(loc.startsWith('http') ? loc : 'https://torontofood.myshopify.com' + loc, { headers: { cookie, 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
  const extra = f.headers.getSetCookie().map((c) => c.split(';')[0]);
  if (extra.length) cookie = cookie + '; ' + extra.join('; ');
}
const H = { cookie, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
for (const h of ['the-videographer-snowboard', 'the-complete-snowboard', 'the-compare-at-price-snowboard']) {
  const p = await fetch(`https://torontofood.myshopify.com/products/${h}.js`, { headers: H });
  const j = await p.json() as { title: string; variants: { id: number; available: boolean }[] };
  console.log(p.status, j.title, '→', j.variants.map((v) => `${v.id}:${v.available}`).join(', '));
}
const add = await fetch('https://torontofood.myshopify.com/cart/add.js', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 67743871205698, quantity: 1 }] }),
});
console.log('cart add →', add.status, (await add.text()).slice(0, 400));
