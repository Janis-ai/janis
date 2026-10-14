const pw = process.env.SF_PW!;
const H = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const jar: string[] = [];
const addCookies = (r: Response) => r.headers.getSetCookie().forEach((c) => jar.push(c.split(';')[0]));
const cookie = () => jar.join('; ');

// 1) GET the password page like a browser would
const g = await fetch('https://torontofood.myshopify.com/password', { headers: H, redirect: 'manual' });
addCookies(g);
console.log('GET /password →', g.status);
const html = await g.text();
// form action / hidden inputs
const action = /action="([^"]*)"/.exec(html)?.[1];
const hidden = [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => m[0]);
console.log('form action:', action, '| hidden inputs:', hidden.length, hidden.join(' ').slice(0, 300));

// 2) POST with cookies + UA
const r = await fetch(`https://torontofood.myshopify.com${action ?? '/password'}`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
addCookies(r);
console.log('POST →', r.status, r.headers.get('location'));
console.log('jar:', jar.map((c) => c.split('=')[0]).join(', '));

// 3) product.js with the full jar
const pj = await fetch('https://torontofood.myshopify.com/products/the-compare-at-price-snowboard.js', {
  headers: { ...H, accept: 'application/json', cookie: cookie() }, redirect: 'manual' });
console.log('product.js →', pj.status, pj.headers.get('location') ?? '');
if (pj.ok) {
  const p = await pj.json() as { variants: { id: number; available: boolean }[] };
  console.log('variants:', p.variants.map((v) => `${v.id}:${v.available}`).join(' '));
}
