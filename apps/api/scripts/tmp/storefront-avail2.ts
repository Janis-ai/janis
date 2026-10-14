const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const pj = await fetch('https://torontofood.myshopify.com/products/the-compare-at-price-snowboard.js', {
  headers: { accept: 'application/json', cookie }, redirect: 'manual' });
console.log('status', pj.status, '→', pj.headers.get('location'));
// follow once manually in case it's locale/canonical
const loc = pj.headers.get('location');
if (loc) {
  const pj2 = await fetch(loc.startsWith('http') ? loc : `https://torontofood.myshopify.com${loc}`, {
    headers: { accept: 'application/json', cookie }, redirect: 'manual' });
  console.log('followed →', pj2.status, pj2.headers.get('location') ?? '', pj2.headers.get('content-type'));
  const t = await pj2.text();
  console.log('body[:160]:', t.slice(0, 160));
}
