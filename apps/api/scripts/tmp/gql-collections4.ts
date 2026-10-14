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
// shopifyqlQuery return type
const f = await q('{ __type(name:"QueryRoot") { fields { name type { name kind ofType { name } } } } }');
const fields = (f.data?.__type?.fields ?? []).filter((x: any) => /shopifyql|products$|collection/i.test(x.name));
console.log('fields:', JSON.stringify(fields));
// BEST_SELLING with a query arg
for (const query of ['*', 'title:*', 'status:active']) {
  const bs = await q(`{ products(first: 12, sortKey: BEST_SELLING, query: "${query}") { nodes { title } } }`);
  console.log(`BS q=${query}:`, JSON.stringify((bs.data?.products?.nodes ?? []).map((n: any) => n.title)) || JSON.stringify(bs.errors?.[0]?.message));
}
process.exit(0);
