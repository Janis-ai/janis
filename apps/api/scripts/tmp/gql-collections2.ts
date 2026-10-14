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
// products filtered to a real collection
const pc = await q('{ products(first: 5, query: "collection_id:533031747867") { nodes { title } } }');
console.log('BY collection_id:', JSON.stringify(pc.data?.products?.nodes ?? pc.errors));
// collection:handle syntax
const ph = await q('{ products(first: 5, query: "collection:hydrogen") { nodes { title } } }');
console.log('BY collection:handle:', JSON.stringify(ph.data?.products?.nodes ?? ph.errors));
// BEST_SELLING sort
const bs = await q('{ products(first: 12, sortKey: BEST_SELLING, query: "status:active") { nodes { title } } }');
console.log('BEST_SELLING:', JSON.stringify((bs.data?.products?.nodes ?? []).map((n: any) => n.title)) || JSON.stringify(bs.errors));
// ShopifyQL — units sold per product
const ql = await q('{ shopifyqlQuery(query: "FROM sales SHOW ordered_quantity, total_sales BY product_title SINCE -90d") { __typename ... on TableResponse { tableData { columns { name dataType } rows } } parseErrors } }');
console.log('SHOPIFYQL:', JSON.stringify(ql).slice(0, 1500));
process.exit(0);
