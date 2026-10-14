import { storefrontTruth } from '../../src/lib/widgets.js';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const secrets = { SHOPIFY_SHOP: shop, SHOPIFY_STOREFRONT_PASSWORD: 'cheuse' };
const mk = () => ({ type: 'cards' as const, items: [
  { title: 'The 3p Fulfilled Snowboard', price: '$2,498.45', cart_variant_id: '54223607759131', link: 'https://janis-store-sx5bpcd3.myshopify.com/products/the-3p-fulfilled-snowboard' },
  { title: 'Videographer', price: '$841.65', cart_variant_id: '54223607759039', link: 'https://janis-store-sx5bpcd3.myshopify.com/products/the-videographer-snowboard' },
]});
const badge = mk();
console.log('badge flips:', await storefrontTruth(badge as never, secrets, 'badge'), JSON.stringify(badge.items.map(i=>({t:i.title,s:i.stock,c:!!i.cart_variant_id}))));
const drop = mk();
console.log('drop flips:', await storefrontTruth(drop as never, secrets, 'drop'), JSON.stringify(drop.items.map(i=>i.title)));
process.exit(0);
