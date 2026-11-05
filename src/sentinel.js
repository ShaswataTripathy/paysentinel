// The Sentinel: fixed rules decide whether a held agent payment is captured, sent for approval, or voided.
// No AI in here on purpose: model output is untrusted, so the money decision must be deterministic.
import { getShop, getProduct, injectedSkus, nameMatches } from './catalog.js';

const cents = (n) => Math.round(Number(n) * 100);
const fmt = (n, cur = 'USD') => `${cur} ${(Number(n)).toFixed(2)}`;

/** Does a product name satisfy the mandate's keywords? */
export function matchesIntent(name, mandate) {
  return nameMatches(name, mandate.must_match);
}

/**
 * @param mandate  { must_match[], quantity, max_unit_price, max_total, currency, allowed_shops[] }
 * @param order    { shop, currency, total, items: [{ sku, name, quantity, unit_price }] }  (as PayPal holds it)
 * @param guardian optional Guardian mode context (see guardianChecks)
 * @returns { decision: 'capture'|'review'|'void', checks: [{ id, label, status: 'pass'|'review'|'block', detail }] }
 */
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

  // 2. Every item exists in the shop's public catalog
  const unknown = order.items.filter((it) => !getProduct(order.shop, it.sku));
  add('catalog', 'Items exist in the catalog', unknown.length ? 'block' : 'pass',
    unknown.length ? `Not in the shop's catalog: ${unknown.map((i) => i.name).join(', ')}.` : 'Every item is a real catalog listing.');

  // 3. Every item is something you asked for
  const extra = order.items.filter((it) => !matchesIntent(it.name, mandate));
  add('intent', 'Only items you asked for', extra.length ? 'block' : 'pass',
    extra.length ? `You did not ask for: ${extra.map((i) => i.name).join(', ')}.` : 'Every item matches your request.');

  // 4. Hidden instructions in listings pushed an item into the cart
  const injected = injectedSkus(order.shop);
  const pushed = order.items.filter((it) => injected.has(it.sku));
  if (pushed.length) {
    const src = injected.get(pushed[0].sku);
    add('injection', 'No items planted by listing text', 'block',
      `${pushed.map((i) => i.name).join(', ')} was demanded by hidden text in listing ${src.from} (${src.reasons.join(', ')}), not by you.`);
  } else add('injection', 'No items planted by listing text', 'pass', 'No cart item traces back to hidden listing text.');

  // 5. Prices charged equal the prices listed (catches price drift at checkout)
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

  // 7. Budget: up to 10% over (per item or in total) goes to you for approval; more is blocked
  const total = cents(order.total);
  const ratio = Math.max(
    total / cents(mandate.max_total),
    ...order.items.filter((it) => matchesIntent(it.name, mandate)).map((it) => cents(it.unit_price) / cents(mandate.max_unit_price)),
  );
  const vs = `Total ${fmt(order.total, cur)}, your limit ${fmt(mandate.max_total, cur)}`;
  if (ratio > 1.1) add('budget', 'Within your budget', 'block', `${vs}: more than 10% over.`);
  else if (ratio > 1) add('budget', 'Within your budget', 'review', `${vs}: slightly over.`);
  else add('budget', 'Within your budget', 'pass', `${vs}.`);

  // 8. The amount PayPal is holding equals the sum of the items (catches a tampered total)
  const sum = order.items.reduce((s, it) => s + cents(it.unit_price) * Number(it.quantity), 0);
  add('total', 'Held amount = item total', sum === total ? 'pass' : 'block',
    sum === total ? `PayPal is holding exactly ${fmt(order.total, cur)}.` : `PayPal holds ${fmt(order.total, cur)} but items add up to ${fmt(sum / 100, cur)}.`);

  if (guardian) guardianChecks(guardian, order, shop, add, cur);

  const decision = checks.some((c) => c.status === 'block') ? 'void' : checks.some((c) => c.status === 'review') ? 'review' : 'capture';
  return { decision, checks };
}

/**
 * Guardian mode: rules a family member set for someone else's AI assistant. They apply on top of the request,
 * so a scam that talks the person into asking for something risky is still stopped.
 * guardian = { name, rules: { allowed_categories, blocked_categories, per_order_limit, weekly_limit, verified_shops_only }, spentThisWeek }
 */
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
