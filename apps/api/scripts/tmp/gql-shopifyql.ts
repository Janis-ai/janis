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
const r = await q('{ shopifyqlQuery(query: "FROM sales SHOW ordered_quantity, gross_sales BY product_title SINCE -90d ORDER BY ordered_quantity DESC") { tableData { columns { name dataType } rowData } parseErrors { code message } parseWarnings { code message } } }');
console.log(JSON.stringify(r, null, 0).slice(0, 2000));
process.exit(0);
