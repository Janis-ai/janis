import { storefrontProduct, storefrontTruth } from '../../src/lib/widgets.js';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const pwd = 'cheuse';
const p = await storefrontProduct(shop, 'the-3p-fulfilled-snowboard', pwd);
console.log('3p product:', p ? { available: p.available, variants: p.variants?.map(v=>({id:v.id,avail:v.available})) } : 'NULL');
const wax = await storefrontProduct(shop, 'selling-plans-ski-wax', pwd);
console.log('wax:', wax ? { available: wax.available, vCount: wax.variants?.length } : 'NULL');
// card-level truth check
const w = { type: 'cards' as const, items: [
  { title: 'The 3p Fulfilled Snowboard', price: '$2,498.45', cart_variant_id: '1', link: 'https://janis-store-sx5bpcd3.myshopify.com/products/the-3p-fulfilled-snowboard' },
  { title: 'Videographer', price: '$841.65', cart_variant_id: '2', link: 'https://janis-store-sx5bpcd3.myshopify.com/products/the-videographer-snowboard' },
]};
const flips = await storefrontTruth(w as never, { SHOPIFY_SHOP: shop, SHOPIFY_STOREFRONT_PASSWORD: pwd }, 'badge');
console.log('flips:', flips, JSON.stringify(w.items));
process.exit(0);
