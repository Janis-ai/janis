const shop = 'janis-store-sx5bpcd3.myshopify.com';
const url = `https://${shop}/products/the-3p-fulfilled-snowboard.js`;
const r1 = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
console.log('r1:', r1.status, 'redirected:', r1.redirected, 'url:', r1.url.slice(0, 80), 'ct:', r1.headers.get('content-type'));
const r2 = await fetch(`https://${shop}/password`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'form_type=storefront_password&utf8=%E2%9C%93&password=cheuse',
  redirect: 'manual',
});
console.log('pw:', r2.status, 'setCookie:', (r2.headers as any).getSetCookie?.().length, JSON.stringify((r2.headers as any).getSetCookie?.()?.[0]?.slice(0,50)));
const cookies = (r2.headers as any).getSetCookie?.().map((c:string)=>/^[^;]+/.exec(c)?.[0]).join('; ');
const r3 = await fetch(url, { headers: { accept: 'application/json', cookie: cookies }, signal: AbortSignal.timeout(4000) });
console.log('r3:', r3.status, 'redirected:', r3.redirected, 'url:', r3.url.slice(0,80));
const j = await r3.json().catch(e => 'PARSE FAIL ' + e);
console.log('json available:', typeof j === 'object' ? j.available : j);
process.exit(0);
