// Rule engine: capture, review or void a held payment. No AI here on purpose.
import { getShop, getProduct, injectedSkus, nameMatches } from './catalog.js';

const cents = (n) => Math.round(Number(n) * 100);
const fmt = (n, cur = 'USD') => `${cur} ${(Number(n)).toFixed(2)}`;

export function matchesIntent(name, mandate) {
  return nameMatches(name, mandate.must_match);
}

// order is PayPal's view of the held order
export function verify(mandate, order, guardian = null) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const shop = getShop(order.shop);
  const cur = order.currency || mandate.currency;

  // 1. Shop
  if (!shop) add('shop', 'Shop is known', 'block', `Unknown shop "${order.shop}".`);
  else if (mandate.allowed_shops?.length && !mandate.allowed_shops.includes(shop.id))
    add('shop', 'Shop is allowed', 'block', `${shop.name} is not on your allowed list.`);
  else if (!shop.trusted) add('shop', 'Shop is trusted', 'review', `${shop.name} is not a verified shop.`);
  else add('shop', 'Shop is trusted', 'pass', `${shop.name} is a verified shop.`);

  // 2. Catalog
  const items = Array.isArray(order.items) ? order.items : [];
  const malformed = items.filter((it) => !Number.isInteger(Number(it.quantity)) || Number(it.quantity) < 1 || !(Number(it.unit_price) > 0));
  const unknown = items.filter((it) => !getProduct(order.shop, it.sku));
  if (!items.length) add('catalog', 'Items exist in the catalog', 'block', 'PayPal holds an order with no items.');
  else if (malformed.length) add('catalog', 'Items exist in the catalog', 'block', `Invalid quantity or price for: ${malformed.map((i) => i.name ?? i.sku).join(', ')}.`);
  else add('catalog', 'Items exist in the catalog', unknown.length ? 'block' : 'pass',
    unknown.length ? `Not in the shop's catalog: ${unknown.map((i) => i.name).join(', ')}.` : 'Every item is a real catalog listing.');

  // 3. Intent
  const extra = order.items.filter((it) => !matchesIntent(it.name, mandate));
  add('intent', 'Only items you asked for', extra.length ? 'block' : 'pass',
    extra.length ? `You did not ask for: ${extra.map((i) => i.name).join(', ')}.` : 'Every item matches your request.');

  // 4. Injected items
  const injected = injectedSkus(order.shop);
  const pushed = order.items.filter((it) => injected.has(it.sku));
  if (pushed.length) {
    const src = injected.get(pushed[0].sku);
    add('injection', 'No items planted by listing text', 'block',
      `${pushed.map((i) => i.name).join(', ')} was demanded by hidden text in listing ${src.from} (${src.reasons.join(', ')}), not by you.`);
  } else add('injection', 'No items planted by listing text', 'pass', 'No cart item traces back to hidden listing text.');

  // 5. Price drift
  const drift = order.items
    .map((it) => ({ it, listed: getProduct(order.shop, it.sku)?.price }))
    .filter(({ it, listed }) => listed != null && cents(it.unit_price) !== cents(listed));
  add('price', 'Charged price = listed price', drift.length ? 'block' : 'pass',
    drift.length
      ? drift.map(({ it, listed }) => `${it.name}: listed ${fmt(listed, cur)}, charged ${fmt(it.unit_price, cur)}`).join('; ') + '.'
      : 'Every price matches the public listing.');

  // 6. Quantity
  const qty = order.items.filter((it) => matchesIntent(it.name, mandate)).reduce((s, it) => s + Number(it.quantity), 0);
  if (qty > mandate.quantity) add('quantity', 'Quantity as requested', 'block', `Asked for ${mandate.quantity}, cart has ${qty}.`);
  else if (qty < mandate.quantity) add('quantity', 'Quantity as requested', 'review', `Asked for ${mandate.quantity}, cart has ${qty}.`);
  else add('quantity', 'Quantity as requested', 'pass', `${qty} as requested.`);

  // 7. Budget (<=10% over -> review)
  const total = cents(order.total);
  const limitsOk = cents(mandate.max_total) > 0 && cents(mandate.max_unit_price) > 0;
  const ratio = !limitsOk || !Number.isFinite(total) ? Infinity : Math.max(
    total / cents(mandate.max_total),
    ...order.items.filter((it) => matchesIntent(it.name, mandate)).map((it) => cents(it.unit_price) / cents(mandate.max_unit_price)),
  );
  const vs = `Total ${fmt(order.total, cur)}, your limit ${fmt(mandate.max_total, cur)}`;
  if (ratio > 1.1) add('budget', 'Within your budget', 'block', `${vs}: more than 10% over.`);
  else if (ratio > 1) add('budget', 'Within your budget', 'review', `${vs}: slightly over.`);
  else add('budget', 'Within your budget', 'pass', `${vs}.`);

  // 8. Held total and currency
  const sum = order.items.reduce((s, it) => s + cents(it.unit_price) * Number(it.quantity), 0);
  if (order.currency && order.currency !== mandate.currency)
    add('total', 'Held amount = item total', 'block', `PayPal holds ${order.currency} but your limit is in ${mandate.currency}.`);
  else add('total', 'Held amount = item total', sum === total && total > 0 ? 'pass' : 'block',
    sum === total ? `PayPal is holding exactly ${fmt(order.total, cur)}.` : `PayPal holds ${fmt(order.total, cur)} but items add up to ${fmt(sum / 100, cur)}.`);

  if (guardian) guardianChecks(guardian, order, shop, add, cur);

  const decision = checks.some((c) => c.status === 'block') ? 'void' : checks.some((c) => c.status === 'review') ? 'review' : 'capture';
  return { decision, checks };
}

// guardian = { name, rules, spentThisWeek }
function guardianChecks(guardian, order, shop, add, cur) {
  const r = guardian.rules;
  const who = guardian.name;
  const cat = (it) => getProduct(order.shop, it.sku)?.category ?? 'unknown';

  const blocked = order.items.filter((it) => r.blocked_categories.includes(cat(it)));
  const outside = order.items.filter((it) => !r.blocked_categories.includes(cat(it)) && !r.allowed_categories.includes(cat(it)));
  if (blocked.length)
    add('g_category', `Guardian: allowed categories`, 'block', `${who} blocked ${[...new Set(blocked.map(cat))].join(', ').replace('_', ' ')}: ${blocked.map((i) => i.name).join(', ')}.`);
  else if (outside.length)
    add('g_category', `Guardian: allowed categories`, 'review', `${outside.map((i) => i.name).join(', ')} is outside the categories ${who} allowed.`);
  else add('g_category', `Guardian: allowed categories`, 'pass', `Every item is in a category ${who} allowed.`);

  if (r.verified_shops_only && shop && !shop.trusted)
    add('g_shop', 'Guardian: verified shops only', 'block', `${who} only allows verified shops; ${shop.name} is not verified.`);

  const total = cents(order.total);
  if (total > cents(r.per_order_limit))
    add('g_order', 'Guardian: per-order limit', 'review', `${fmt(order.total, cur)} is over the ${fmt(r.per_order_limit, cur)} per-order limit, so ${who} must approve.`);
  else add('g_order', 'Guardian: per-order limit', 'pass', `Within the ${fmt(r.per_order_limit, cur)} per-order limit.`);

  const week = cents(guardian.spentThisWeek ?? 0) + total;
  if (week > cents(r.weekly_limit))
    add('g_week', 'Guardian: weekly budget', 'review', `This would bring the week to ${fmt(week / 100, cur)}, over the ${fmt(r.weekly_limit, cur)} weekly budget.`);
  else add('g_week', 'Guardian: weekly budget', 'pass', `${fmt(week / 100, cur)} of ${fmt(r.weekly_limit, cur)} this week.`);
}
