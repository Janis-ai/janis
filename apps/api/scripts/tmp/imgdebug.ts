import '../../src/loadEnv.js';
const res = await fetch('https://jonathanferrier.com/properties/44-moberly-avenue', {
  headers: { 'user-agent': 'JanisKB/1.0 (+knowledge refresh)' },
});
const html = await res.text();
console.log('status', res.status, 'type', res.headers.get('content-type'), 'len', html.length);
console.log('has og:image:', /property=["']og:image/.test(html));
console.log('meta count:', (html.match(/<meta[^>]+>/gi) ?? []).length);
console.log('og match:', html.match(/<meta[^>]*og:image[^>]*>/i)?.[0]?.slice(0, 200));
process.exit(0);
