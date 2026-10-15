const pw = 'skatwo';
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0' },
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
const l = await fetch('https://torontofood.myshopify.com/localization', {
  method: 'POST',
  headers: { ...{ cookie, 'user-agent': 'Mozilla/5.0' }, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'localization', utf8: '✓', _method: 'put', return_to: '/', country_code: 'US' }),
  redirect: 'manual',
});
const locCookies = l.headers.getSetCookie().map((c) => c.split(';')[0]);
if (locCookies.length) cookie = cookie + '; ' + locCookies.join('; ');
const H = { cookie, 'user-agent': 'Mozilla/5.0' };
const add = await fetch('https://torontofood.myshopify.com/cart/add.js', {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 67743871205698, quantity: 1 }] }) });
console.log('cart add (US market) →', add.status, (await add.text()).slice(0, 250));
const cart = await fetch('https://torontofood.myshopify.com/cart.js', { headers: H });
console.log('cart →', (await cart.text()).slice(0, 300));
