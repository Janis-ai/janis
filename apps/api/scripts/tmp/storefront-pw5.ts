const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const jar = res.headers.getSetCookie().map((c) => c.split(';')[0]);
const cookie = jar.join('; ');
const list = await fetch('https://torontofood.myshopify.com/products.json?limit=50', { headers: { cookie } });
const { products } = await list.json() as { products: { title: string; handle: string; variants: { id: number; available?: boolean }[] }[] };
console.log('products:', products.length);
const p = products.find((x) => x.title.includes('Compare at Price')) ?? products[0];
const v = p?.variants?.[0];
console.log('adding:', p?.title, '| variant', v?.id);
const cart = await fetch('https://torontofood.myshopify.com/cart/add.js', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ items: [{ id: v?.id, quantity: 1 }] }),
});
console.log('cart add →', cart.status, (await cart.text()).slice(0, 200));
