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
const H = { cookie, 'user-agent': 'Mozilla/5.0' };
const l = await fetch('https://torontofood.myshopify.com/localization', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'localization', utf8: '✓', _method: 'put', return_to: '/', country_code: 'US' }),
  redirect: 'manual',
});
const locCookies = l.headers.getSetCookie().map((c) => c.split(';')[0]);
console.log('localization →', l.status, 'cookies:', locCookies);
if (locCookies.length) cookie = cookie + '; ' + locCookies.join('; ');
const p = await fetch('https://torontofood.myshopify.com/products/the-videographer-snowboard.js', { headers: { cookie, 'user-agent': 'Mozilla/5.0' } });
const j = await p.json() as { title: string; variants: { id: number; available: boolean }[] };
console.log('after US loc:', j.title, j.variants.map((v) => `${v.id}:${v.available}`).join(','));
