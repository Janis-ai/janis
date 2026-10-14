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
// does the store even have orders to derive sales from?
const oc = await q('{ ordersCount { count } }');
console.log('ordersCount:', JSON.stringify(oc.data ?? oc.errors));
// sanity: does sorting work at all?
const st = await q('{ products(first: 5, sortKey: TITLE) { nodes { title } } }');
console.log('TITLE sort:', JSON.stringify((st.data?.products?.nodes ?? []).map((n: any) => n.title)) || JSON.stringify(st.errors?.[0]));
// shopifyqlQuery type shape
const t = await q('{ __type(name:"ShopifyqlQueryResponse") { fields { name type { name kind ofType { name kind } } } } }');
console.log('sqlQueryResponse fields:', JSON.stringify(t.data?.__type?.fields));
process.exit(0);
