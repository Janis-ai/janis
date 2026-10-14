const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
const TOKEN = process.env.SHOPIFY_TOKEN!;
const q = async (query: string) => {
  const r = await fetch(`https://${SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
};
// ShopifyqlResponse union member types
const t = await q('{ __type(name:"ShopifyqlResponse") { kind possibleTypes { name } } }');
console.log('ShopifyqlResponse:', JSON.stringify(t.data));
// BEST_SELLING without query filter
const bs = await q('{ products(first: 12, sortKey: BEST_SELLING) { nodes { title status } } }');
console.log('BEST_SELLING no filter:', JSON.stringify((bs.data?.products?.nodes ?? []).map((n:any)=>n.title)) || JSON.stringify(bs.errors));
// and with the sortKey alone on the default set
process.exit(0);
