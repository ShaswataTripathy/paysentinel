// Signed evidence packs used to answer disputes.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getShop, getProduct } from './catalog.js';

const DEV_SECRET = 'paysentinel-dev-secret-change-me';
const SECRET = process.env.RECEIPT_SECRET || DEV_SECRET;
export const usingDevSecret = SECRET === DEV_SECRET;

// sorted keys so the hash is stable
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function catalogSnapshot(order) {
  const shop = getShop(order.shop);
  return {
    shop: { id: order.shop, name: shop?.name ?? null, verified: !!shop?.trusted },
    items: order.items.map((it) => {
      const p = getProduct(order.shop, it.sku);
      return { sku: it.sku, listed_name: p?.name ?? null, listed_price: p?.price ?? null, category: p?.category ?? null };
    }),
    taken_at: new Date().toISOString(),
  };
}

function receiptBody(d) {
  return {
    decision_id: d.id,
    decided_at: d.at,
    request: d.request,
    mandate: {
      must_match: d.mandate.must_match,
      quantity: d.mandate.quantity,
      max_unit_price: d.mandate.max_unit_price,
      max_total: d.mandate.max_total,
      currency: d.mandate.currency,
      created_at: d.mandate.createdAt,
    },
    on_behalf_of: d.profileName,
    approver: d.approver,
    resolved_by: d.resolvedBy,
    paypal: { order_id: d.order.id, authorization_id: d.order.authorizationId, capture_id: d.payment?.id ?? null, outcome: d.payment?.action ?? null },
    order: { shop: d.order.shop, total: d.order.total, currency: d.order.currency, items: d.order.items },
    catalog_at_decision: d.catalogSnapshot,
    checks: d.checks.map(({ id, status, detail }) => ({ id, status, detail })),
    decision: d.decision,
  };
}

export function signReceipt(d) {
  const body = receiptBody(d);
  const text = canonical(body);
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    hmac: createHmac('sha256', SECRET).update(text).digest('hex'),
    signed_at: new Date().toISOString(),
  };
}

export function verifyReceipt(d) {
  if (!d.receipt?.hmac || !/^[0-9a-f]{64}$/.test(d.receipt.hmac)) return false;
  const expected = Buffer.from(signReceipt(d).hmac, 'hex');
  const got = Buffer.from(d.receipt.hmac, 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function evidencePack(d) {
  return {
    title: 'PaySentinel evidence pack',
    summary:
      d.payment?.action === 'captured'
        ? `This payment was made by an AI agent acting for ${d.profileName}. Before PayPal captured it, PaySentinel checked the order against the instruction "${d.request}" and ${d.resolvedBy === 'sentinel' ? `all ${d.checks.length} checks passed` : `${d.approver} approved it`}.`
        : `This payment was not captured: PaySentinel ${d.payment?.action ?? 'held'} it.`,
    ...receiptBody(d),
    agent_trace: d.trace,
    receipt: d.receipt ?? null,
    receipt_valid: verifyReceipt(d),
  };
}
