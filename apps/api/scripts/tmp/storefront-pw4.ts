const pw = process.env.SF_PW!;
// 1) password POST → 302 + _shopify_essential
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
let jar = res.headers.getSetCookie().map((c) => c.split(';')[0]);
// 2) follow redirect — digest should land here
const home = await fetch(res.headers.get('location')!, {
  headers: { cookie: jar.join('; ') }, redirect: 'manual' });
console.log('home →', home.status);
for (const c of home.headers.getSetCookie()) {
  console.log('  set:', c.split('=')[0]);
  jar.push(c.split(';')[0]);
}
const cookie = jar.join('; ');
const pj = await fetch('https://torontofood.myshopify.com/products/snowboard.js', {
  headers: { accept: 'application/json', cookie }, redirect: 'manual' });
console.log('product.js →', pj.status);
if (pj.ok) {
  const p = await pj.json() as { title?: string; variants?: { id: number; available: boolean }[] };
  const v = p.variants?.find((x) => x.available) ?? p.variants?.[0];
  console.log('product:', p.title, '| variant', v?.id, 'avail:', v?.available);
  if (v) {
    const cart = await fetch('https://torontofood.myshopify.com/cart/add.js', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ items: [{ id: v.id, quantity: 1 }] }),
    });
    console.log('cart add →', cart.status, (await cart.text()).slice(0, 200));
  }
}
