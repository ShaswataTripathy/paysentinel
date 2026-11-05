import 'dotenv/config'; // must be first: other modules read env at import time
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractMandate, explainDecision, normalizeProducts, draftDisputeResponse, aiMock, aiModels } from './ai.js';
import { runAgent, externalRun } from './agent.js';
import { verify } from './sentinel.js';
import { listShops, getShop, getProduct, search, scanListing, scanRawText, upsertShop } from './catalog.js';
import { createHeldOrder, authorizeOrder, captureAuthorization, voidAuthorization, paypalMock, clientId, cardDemo } from './paypal.js';
import { listProfiles, getProfile, updateRules, CATEGORIES } from './profiles.js';
import { catalogSnapshot, signReceipt, evidencePack } from './evidence.js';
import { simulateDispute, findDisputeForCapture, provideEvidence } from './paypal.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'data', 'decisions.json');

const app = express();
app.use(express.json({ limit: '200kb' }));
// The React UI (web/, built to web/dist) when it has been built; otherwise the original plain UI in public/.
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const UI_DIR = fs.existsSync(path.join(WEB_DIST, 'index.html')) ? WEB_DIST : path.join(ROOT, 'public');
app.use(express.static(UI_DIR));

// ---------------- state ----------------
const mandates = new Map(); // id -> mandate
const runs = new Map(); // run id -> agent run (kept server-side so the browser cannot edit the cart)
const checkouts = new Map(); // paypal order id -> { mandateId, run }
const decisions = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
const saveLog = () => fs.writeFileSync(LOG_FILE, JSON.stringify(decisions.slice(-200), null, 2));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
const need = (cond, res, msg, code = 400) => (cond ? false : (res.status(code).json({ error: msg }), true));

// ---------------- config & shops ----------------
app.get('/api/config', (req, res) => res.json({ paypalMock, cardDemo, aiMock, aiModels: aiMock ? null : aiModels, paypalClientId: clientId }));

app.get('/api/shops', (req, res) => res.json(listShops()));

app.get('/api/shops/:id', (req, res) => {
  const shop = getShop(req.params.id);
  if (need(shop, res, 'Shop not found', 404)) return;
  res.json({ ...shop, products: shop.products.map(({ checkout_price, ...p }) => ({ ...p, scan: scanListing(shop.id, p) })) });
});

// Shelf: messy product list -> agent-readable shop
app.post(
  '/api/shelf/import',
  wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    const raw = String(req.body?.products ?? '');
    if (need(name && raw.trim(), res, 'Shop name and a product list are required.')) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `shop-${Date.now()}`;
    const products = await normalizeProducts(raw, id);
    if (need(products.length, res, 'No products with a name and price were found.')) return;
    const shop = upsertShop({ id, name, trusted: false, products });
    // Report instructions aimed at AI agents found in the seller's raw text, even if the AI clean-up dropped them.
    const removed = scanRawText(raw);
    res.status(201).json({ ...shop, removed, products: shop.products.map((p) => ({ ...p, scan: scanListing(id, p) })) });
  }),
);

// ---------------- Guardian mode ----------------
app.get('/api/profiles', (req, res) => res.json({ profiles: listProfiles(), categories: CATEGORIES }));

app.put(
  '/api/profiles/:id/rules',
  wrap(async (req, res) => {
    if (need(getProfile(req.params.id)?.guardian, res, 'Profile has no guardian', 404)) return;
    res.json(updateRules(req.params.id, req.body ?? {}));
  }),
);

/** What this person's agent has already spent in the last 7 days (captured payments only). */
function spentThisWeek(profileId) {
  const since = Date.now() - 7 * 864e5;
  return decisions
    .filter((d) => d.profileId === profileId && d.payment?.action === 'captured' && Date.parse(d.at) >= since)
    .reduce((s, d) => s + Number(d.order.total), 0);
}

// ---------------- 1. intent -> mandate ----------------
app.post(
  '/api/mandates',
  wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    if (need(text, res, 'Tell the agent what to buy.')) return;
    const profile = getProfile(String(req.body?.profileId ?? 'self'));
    if (need(profile, res, 'Unknown profile', 404)) return;
    const mandate = { id: randomUUID(), createdAt: new Date().toISOString(), profileId: profile.id, ...(await extractMandate(text)) };
    mandates.set(mandate.id, mandate);
    res.status(201).json(mandate);
  }),
);

// ---------------- 2. agent shops ----------------
app.post(
  '/api/mandates/:id/run',
  wrap(async (req, res) => {
    const mandate = mandates.get(req.params.id);
    if (need(mandate, res, 'Mandate not found', 404)) return;
    if (need(!mandate.missing.length, res, `The request is missing ${mandate.missing.join(' and ')}.`)) return;
    const run = await runAgent(mandate, { mode: req.body?.agent === 'gemini' ? 'gemini' : 'simulated', attack: !!req.body?.attack });
    const runId = randomUUID();
    runs.set(runId, { ...run, mandateId: mandate.id });
    res.json({ runId, ...run });
  }),
);

// ---------------- 2b. outside agents (MCP server) ----------------
// An outside agent sees every shop, like on the open web. Listings are returned as written, hidden text included:
// PaySentinel does not try to make the agent safe, it makes the payment safe.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (need(q, res, 'Give a search query.')) return;
  res.json(search(q).slice(0, 10).map(({ score, ...r }) => r));
});

app.get('/api/shops/:shop/products/:sku', (req, res) => {
  const p = getProduct(req.params.shop, req.params.sku);
  if (need(p, res, 'Product not found', 404)) return;
  const { checkout_price, ...listing } = p;
  res.json({ shop: req.params.shop, ...listing });
});

app.post(
  '/api/mandates/:id/cart',
  wrap(async (req, res) => {
    const mandate = mandates.get(req.params.id);
    if (need(mandate, res, 'Mandate not found', 404)) return;
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
    if (need(items.length, res, 'Send at least one item: { shop, sku, quantity }.')) return;
    const agent = String(req.body?.agent ?? 'mcp-client').replace(/[^\w .:-]/g, '').slice(0, 40) || 'mcp-client';
    const run = externalRun(items, agent);
    const runId = randomUUID();
    runs.set(runId, { ...run, mandateId: mandate.id });
    res.status(201).json({ runId, ...run });
  }),
);

// ---------------- 3. hold the money ----------------
app.post(
  '/api/checkout',
  wrap(async (req, res) => {
    const run = runs.get(String(req.body?.runId));
    if (need(run, res, 'Agent run not found', 404)) return;
    if (need(!run.checkedOut, res, 'This cart was already sent to PayPal. Let the agent shop again.', 409)) return;
    run.checkedOut = true; // one payment per agent run
    const mandateId = run.mandateId;
    const mandate = mandates.get(mandateId);
    const cart = run.cart;
    if (need(cart?.shop && cart.items?.length, res, 'The agent did not put anything in the cart.')) return;
    const { id, approveUrl } = await createHeldOrder(cart, { currency: mandate.currency, reference: mandate.id.slice(0, 32), testCard: req.body?.method === 'card' });
    checkouts.set(id, { mandateId, run });
    res.status(201).json({ orderId: id, approveUrl: approveUrl ?? null });
  }),
);

// ---------------- 4. buyer approved: authorize, verify, decide ----------------
app.post(
  '/api/orders/:orderId/authorize',
  wrap(async (req, res) => {
    const pending = checkouts.get(req.params.orderId);
    if (need(pending, res, 'Unknown checkout', 404)) return;
    const mandate = mandates.get(pending.mandateId);

    const profile = getProfile(mandate.profileId);
    const guardian = profile?.guardian ? { ...profile.guardian, spentThisWeek: spentThisWeek(profile.id) } : null;

    const held = await authorizeOrder(req.params.orderId); // what PayPal actually holds
    const result = verify(mandate, held, guardian); // fixed rules, no AI
    let payment = { status: 'HELD' };
    if (result.decision === 'capture') payment = { ...(await captureAuthorization(held.authorizationId)), action: 'captured' };
    if (result.decision === 'void') payment = { ...(await voidAuthorization(held.authorizationId)), action: 'voided' };

    const decision = {
      id: randomUUID(),
      at: new Date().toISOString(),
      request: mandate.request,
      profileId: profile?.id ?? 'self',
      profileName: profile?.name ?? 'Me',
      approver: guardian ? guardian.name : 'you',
      mandate,
      agent: pending.run.agent,
      trace: pending.run.trace,
      order: held,
      decision: result.decision,
      checks: result.checks,
      payment,
      explanation: await explainDecision(mandate, held, result),
      resolvedBy: result.decision === 'review' ? null : 'sentinel',
      catalogSnapshot: catalogSnapshot(held),
    };
    if (decision.resolvedBy) decision.receipt = signReceipt(decision);
    decisions.push(decision);
    saveLog();
    checkouts.delete(req.params.orderId);
    res.json(decision);
  }),
);

// ---------------- 5. shopper resolves a borderline order ----------------
app.post(
  '/api/decisions/:id/:action(approve|reject)',
  wrap(async (req, res) => {
    const d = decisions.find((x) => x.id === req.params.id);
    if (need(d, res, 'Decision not found', 404)) return;
    if (need(d.decision === 'review' && !d.resolvedBy && !d.resolving, res, 'This payment is not waiting for approval.', 409)) return;
    d.resolving = true; // a double click must not capture twice
    try {
      d.payment =
        req.params.action === 'approve'
          ? { ...(await captureAuthorization(d.order.authorizationId)), action: 'captured' }
          : { ...(await voidAuthorization(d.order.authorizationId)), action: 'voided' };
      d.resolvedBy = d.approver === 'you' ? 'shopper' : 'guardian';
      d.receipt = signReceipt(d);
    } finally {
      delete d.resolving;
    }
    saveLog();
    res.json(d);
  }),
);

app.get('/api/decisions', (req, res) => res.json([...decisions].reverse()));

app.get('/api/decisions/:id', (req, res) => {
  const d = decisions.find((x) => x.id === req.params.id);
  if (need(d, res, 'Decision not found', 404)) return;
  res.json(d);
});

// ---------------- 6. disputes: answer with the signed evidence pack ----------------
const findDecision = (id) => decisions.find((x) => x.id === id);

app.get('/api/decisions/:id/evidence', (req, res) => {
  const d = findDecision(req.params.id);
  if (need(d, res, 'Decision not found', 404)) return;
  res.json(evidencePack(d));
});

// Mock mode only: a buyer says "my AI assistant bought this without my permission".
// In sandbox, open the dispute as the sandbox buyer in the PayPal Resolution Center instead.
app.post(
  '/api/decisions/:id/dispute/simulate',
  wrap(async (req, res) => {
    const d = findDecision(req.params.id);
    if (need(d?.payment?.action === 'captured', res, 'Only captured payments can be disputed.', 409)) return;
    if (need(paypalMock, res, 'In sandbox, open the dispute as the buyer in the PayPal sandbox Resolution Center, then press "Find dispute".', 409)) return;
    d.dispute = simulateDispute(d.payment.id, d.order.total, d.order.currency);
    saveLog();
    res.json(d.dispute);
  }),
);

app.post(
  '/api/decisions/:id/dispute/find',
  wrap(async (req, res) => {
    const d = findDecision(req.params.id);
    if (need(d?.payment?.action === 'captured', res, 'Only captured payments can be disputed.', 409)) return;
    const found = await findDisputeForCapture(d.payment.id);
    if (need(found, res, 'No dispute found for this payment yet (sandbox disputes can take a few minutes to appear).', 404)) return;
    d.dispute = { ...d.dispute, ...found };
    saveLog();
    res.json(d.dispute);
  }),
);

app.post(
  '/api/decisions/:id/dispute/draft',
  wrap(async (req, res) => {
    const d = findDecision(req.params.id);
    if (need(d?.dispute, res, 'No dispute on this payment.', 404)) return;
    res.json({ notes: await draftDisputeResponse(d.dispute, evidencePack(d)) });
  }),
);

app.post(
  '/api/decisions/:id/dispute/submit',
  wrap(async (req, res) => {
    const d = findDecision(req.params.id);
    if (need(d?.dispute, res, 'No dispute on this payment.', 404)) return;
    const notes = String(req.body?.notes ?? '').trim();
    if (need(notes, res, 'Write or draft a response first.')) return;
    const r = await provideEvidence(d.dispute.dispute_id, notes, evidencePack(d));
    d.dispute = { ...d.dispute, status: r.status, channel: r.channel ?? null, evidence_type: r.evidenceType ?? null, response: notes, responded_at: new Date().toISOString() };
    saveLog();
    res.json(d.dispute);
  }),
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`PaySentinel running at http://localhost:${port}`);
  console.log(`PayPal: ${paypalMock ? 'MOCK (set PAYPAL_CLIENT_ID/SECRET for sandbox)' : 'sandbox'} | AI: ${aiMock ? 'offline heuristics (set GEMINI_API_KEY)' : 'Gemini'}`);
});
