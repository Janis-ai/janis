const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const pg = await fetch('https://torontofood.myshopify.com/products/the-videographer-snowboard', {
  headers: { cookie, 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
const html = await pg.text();
console.log('title tag:', /<title>([^<]*)<\/title>/.exec(html)?.[1]);
console.log('has product title:', html.includes('Videographer'));
console.log('has variant id 67743871205698:', html.includes('67743871205698'));
const price = /\$([\d,.]+)/.exec(html)?.[1];
console.log('price in page:', price);
// also test a nonexistent handle — is 200 just "everything renders"?
const npg = await fetch('https://torontofood.myshopify.com/products/does-not-exist-xyz', {
  headers: { cookie, 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
console.log('nonexistent handle →', npg.status);
