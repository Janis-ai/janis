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
const t = await q('{ __type(name:"ShopifyqlTableData") { fields { name type { name kind ofType { name kind } } } } }');
console.log('tableData fields:', JSON.stringify(t.data?.__type?.fields));
const r = await q('{ shopifyqlQuery(query: "FROM sales SHOW ordered_quantity, gross_sales BY product_title SINCE -90d") { tableData { columns { name } } parseErrors } }');
console.log('query result:', JSON.stringify(r).slice(0, 800));
process.exit(0);
