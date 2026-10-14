const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
console.log('status', res.status, 'location:', res.headers.get('location'));
const cookies = res.headers.getSetCookie();
const names = cookies.map((c) => c.split('=')[0]);
console.log('cookies:', names.join(', '));
const digest = cookies.find((c) => c.toLowerCase().includes('digest'));
if (!digest) { console.log('no digest cookie'); process.exit(0); }
const cookie = digest.split(';')[0];
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
