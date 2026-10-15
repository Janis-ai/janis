const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const list = await fetch('https://torontofood.myshopify.com/products.json?limit=50', { headers: { cookie } });
const { products } = await list.json() as { products: { title: string; handle: string; variants: { id: number; available?: boolean; inventory_quantity?: number }[] }[] };
console.log('products:', products.length);
for (const p of products) {
  const v = p.variants[0];
  console.log(`  ${p.title} | v${v?.id} | avail:${v?.available} | inv:${v?.inventory_quantity}`);
}
// try adding the first AVAILABLE variant
const avail = products.map(p => ({ p, v: p.variants.find(x => x.available !== false) })).find(x => x.v);
if (avail?.v) {
  const cart = await fetch('https://torontofood.myshopify.com/cart/add.js', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ items: [{ id: avail.v.id, quantity: 1 }] }),
  });
  console.log('add', avail.p.title, '→', cart.status, (await cart.text()).slice(0, 200));
}
