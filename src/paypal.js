// PayPal Orders v2 / Payments v2: AUTHORIZE, then capture or void. Mock mode without credentials.
import { randomUUID } from 'node:crypto';
import { log, timed } from './obs.js';

const TIMEOUT_MS = Number(process.env.PAYPAL_TIMEOUT_MS) || 30_000;

const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
export const paypalMock = !(CLIENT_ID && CLIENT_SECRET);
export const clientId = CLIENT_ID ?? null;

let token = null; // { value, expiresAt }

async function getToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`);
  const d = await res.json();
  token = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
  return token.value;
}

// requestId = PayPal-Request-Id, fixed for capture/void so retries are idempotent
async function pp(method, path, body, { requestId = randomUUID() } = {}) {
  const op = path.replace(/\/[A-Z0-9-]{10,}(?=\/|$|\?)/g, '/:id').replace(/\?.*$/, '');
  return timed('paypal_call', { op: `${method} ${op}` }, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': requestId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const debugId = res.headers.get('paypal-debug-id') ?? data?.debug_id;
      const detail = data?.details?.map((d) => [d.issue, d.description].filter(Boolean).join(' ')).join('; ');
      log('warn', 'paypal.error', { method, op, status: res.status, name: data?.name, debugId, detail });
      throw new Error(`PayPal ${method} ${op} failed (${res.status}): ${data?.message ?? data?.name ?? 'unexpected response'}${detail ? ` - ${detail}` : ''}${debugId ? ` (debug id ${debugId})` : ''}`);
    }
    return data;
  });
}

const money = (n) => Number(n).toFixed(2);

function toOrderView(o) {
  const pu = o.purchase_units?.[0] ?? {};
  return {
    id: o.id,
    status: o.status,
    shop: pu.custom_id,
    currency: pu.amount?.currency_code,
    total: Number(pu.amount?.value),
    items: (pu.items ?? []).map((i) => ({ sku: i.sku, name: i.name, quantity: Number(i.quantity), unit_price: Number(i.unit_amount?.value) })),
    authorizationId: pu.payments?.authorizations?.[0]?.id ?? null,
    authorizationStatus: pu.payments?.authorizations?.[0]?.status ?? null,
  };
}

// mock
const mock = new Map();

// API
// PAYPAL_CARD_DEMO: pay with the sandbox test card, PayPal authorizes at creation
export const cardDemo = !paypalMock && /^(1|true|on)$/i.test(process.env.PAYPAL_CARD_DEMO ?? '');
const TEST_CARD = {
  number: process.env.PAYPAL_TEST_CARD_NUMBER || '4032039317984658', // PayPal sandbox test Visa
  expiry: '2030-12',
  security_code: '123',
  name: 'Sandbox Test Buyer',
  billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
};
const preAuthorized = new Map();

export async function createHeldOrder(cart, { currency = 'USD', reference, testCard = false }) {
  if (paypalMock) {
    const id = `MOCK-ORDER-${randomUUID().slice(0, 8).toUpperCase()}`;
    mock.set(id, { id, status: 'CREATED', shop: cart.shop, currency, total: cart.total, items: cart.items, authorizationId: null });
    return { id };
  }
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: reference,
        custom_id: cart.shop,
        description: 'Purchase made by an AI agent, guarded by PaySentinel',
        amount: {
          currency_code: currency,
          value: money(cart.total),
          breakdown: { item_total: { currency_code: currency, value: money(cart.total) } },
        },
        items: cart.items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.sku,
          quantity: String(i.quantity),
          unit_amount: { currency_code: currency, value: money(i.unit_price) },
          category: 'PHYSICAL_GOODS',
        })),
      },
    ],
    payment_source:
      testCard && cardDemo
        ? { card: TEST_CARD }
        : { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'CONTINUE' } } },
  });
  if (testCard && cardDemo) {
    const view = toOrderView(order);
    if (!view.authorizationId) throw new Error(`PayPal did not authorize the test card (order status ${order.status}).`);
    preAuthorized.set(order.id, view);
  }
  const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
  return { id: order.id, approveUrl };
}

export async function authorizeOrder(orderId) {
  if (paypalMock) {
    const o = mock.get(orderId);
    if (!o) throw new Error('Unknown order');
    Object.assign(o, { status: 'COMPLETED', authorizationId: `MOCK-AUTH-${orderId.slice(-8)}`, authorizationStatus: 'CREATED' });
    return { ...o };
  }
  const pre = preAuthorized.get(orderId);
  if (pre) {
    preAuthorized.delete(orderId);
    if (pre.items.length) return pre;
  }
  const o = pre ?? toOrderView(await pp('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}));
  if (o.items.length) return o;
  // authorize response can omit items
  const full = toOrderView(await pp('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  return { ...full, authorizationId: o.authorizationId ?? full.authorizationId, authorizationStatus: o.authorizationStatus ?? full.authorizationStatus };
}

export async function captureAuthorization(authId) {
  if (paypalMock) return { id: `MOCK-CAPTURE-${authId.slice(-8)}`, status: 'COMPLETED' };
  if (!authId) throw new Error('PayPal capture failed: no authorization id.');
  const c = await pp('POST', `/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`, { final_capture: true }, { requestId: `capture-${authId}` });
  return { id: c.id, status: c.status };
}

// Disputes
// sandbox: buyer opens the case in the Resolution Center, we look it up by capture id
const mockDisputes = new Map();

export function simulateDispute(captureId, amount, currency) {
  const id = `MOCK-PP-D-${captureId.slice(-6)}`;
  const d = {
    dispute_id: id,
    reason: 'UNAUTHORISED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    buyer_message: 'I never authorized this purchase. My AI assistant bought it on its own.',
    disputed_amount: { value: Number(amount).toFixed(2), currency_code: currency },
    capture_id: captureId,
  };
  mockDisputes.set(id, d);
  return d;
}

export async function findDisputeForCapture(captureId) {
  if (paypalMock) return [...mockDisputes.values()].find((d) => d.capture_id === captureId) ?? null;
  const list = await pp('GET', `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`);
  const first = list?.items?.[0];
  if (!first) return null;
  const full = await pp('GET', `/v1/customer/disputes/${encodeURIComponent(first.dispute_id)}`);
  return {
    dispute_id: full.dispute_id,
    reason: full.reason,
    status: full.status,
    stage: full.dispute_life_cycle_stage ?? null,
    buyer_message: full.messages?.find((m) => m.posted_by === 'BUYER')?.content ?? null,
    disputed_amount: full.dispute_amount,
    capture_id: captureId,
  };
}

export async function provideEvidence(disputeId, notes, pack) {
  if (paypalMock) {
    const d = mockDisputes.get(disputeId);
    if (!d) throw new Error('Unknown dispute');
    d.status = 'UNDER_REVIEW';
    return { status: d.status };
  }
  const file = () => new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const fileName = `paysentinel-evidence-${disputeId}.json`;
  const post = async (action, form) => {
    const res = await fetch(`${BASE}/v1/customer/disputes/${encodeURIComponent(disputeId)}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  // must use the requested evidence type, OTHER gives EVIDENCE_TYPE_IS_NOT_ALLOWED
  const dispute = await pp('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
  const requested = (dispute.evidences ?? []).find((e) => e.source === 'REQUESTED_FROM_SELLER')?.evidence_type;
  const evidenceType = requested ?? 'OTHER';
  const ev = new FormData();
  ev.append('input', new Blob([JSON.stringify({ evidences: [{ evidence_type: evidenceType, notes: notes.slice(0, 2000) }] })], { type: 'application/json' }));
  ev.append('evidence-file', file(), fileName);
  const r1 = await post('provide-evidence', ev);
  if (r1.ok) return { status: 'UNDER_REVIEW', channel: 'provide-evidence', evidenceType };

  // inquiry stage doesn't take evidence, reply in the thread instead
  if (r1.status === 422 || r1.status === 400) {
    const msg = new FormData();
    msg.append('input', new Blob([JSON.stringify({ message: notes.slice(0, 2000) })], { type: 'application/json' }));
    msg.append('evidence-file', file(), fileName);
    const r2 = await post('send-message', msg);
    if (r2.ok) return { status: 'RESPONDED', channel: 'send-message', note: `provide-evidence (${evidenceType}) not accepted: ${r1.text.slice(0, 120)}` };
    throw new Error(`PayPal rejected the response: provide-evidence ${r1.status} ${r1.text.slice(0, 200)} | send-message ${r2.status} ${r2.text.slice(0, 200)}`);
  }
  throw new Error(`PayPal provide-evidence failed (${r1.status}): ${r1.text.slice(0, 300)}`);
}

export async function voidAuthorization(authId) {
  if (paypalMock) return { status: 'VOIDED' };
  if (!authId) throw new Error('PayPal void failed: no authorization id.');
  const v = await pp('POST', `/v2/payments/authorizations/${encodeURIComponent(authId)}/void`, undefined, { requestId: `void-${authId}` });
  return { status: v?.status ?? 'VOIDED' };
}
