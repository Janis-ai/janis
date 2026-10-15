const SHOP = 'blamp-vzfzgclz.myshopify.com';
const VARIANT_ID = '52686507966680';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const page = await fetch(`https://${SHOP}/products/the-3p-fulfilled-snowboard`, { headers: { 'user-agent': UA } });
const html = await page.text();
console.log('PDP status:', page.status, 'url:', page.url);
console.log('title:', html.match(/<title>([^<]*)<\/title>/)?.[1]);
console.log('has password form:', /password/i.test(html) && /form/i.test(html) ? html.includes('type="password"') : false);
const av = html.match(/"available":(true|false)/g);
console.log('available flags in html:', av?.slice(0, 10));
console.log('sold-out text present:', /sold.?out/i.test(html));
const varJs = html.match(new RegExp(VARIANT_ID + '[^}]{0,300}'));
console.log('variant blob:', varJs?.[0]?.slice(0, 300));

const add = await fetch(`https://${SHOP}/cart/add.js`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA, referer: `https://${SHOP}/products/the-3p-fulfilled-snowboard` },
  body: JSON.stringify({ items: [{ id: Number(VARIANT_ID), quantity: 1 }] }),
});
console.log('ADD status:', add.status);
console.log('ADD body:', (await add.text()).slice(0, 800));
process.exit(0);
