const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
const TOKEN = '***REMOVED***';
const q = async (query: string) => {
  const r = await fetch(`https://${SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
};
// 1. collections list
const c = await q('{ collections(first: 25) { nodes { id title handle descriptionHtml image { url } productsCount { count } ruleSet { appliedDisjunctively } } } }');
console.log('COLLECTIONS:', JSON.stringify(c).slice(0, 2000));
// 2. products by collection filter
const pc = await q('{ products(first: 3, query: "collection_id:452999381275") { nodes { title } } }');
console.log('\nBY COLLECTION_ID:', JSON.stringify(pc).slice(0, 600));
process.exit(0);
