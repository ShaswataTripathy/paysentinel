import 'dotenv/config'; // must be first: other modules read env at import time
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, dataFile } from './paths.js';
import { extractMandate, explainDecision, normalizeProducts, draftDisputeResponse, aiMock, aiModels } from './ai.js';
import { runAgent, externalRun } from './agent.js';
import { verify } from './sentinel.js';
import { listShops, getShop, getProduct, search, scanListing, scanRawText, upsertShop, isProtectedShop, shelfShopCount, MAX_SHELF_SHOPS } from './catalog.js';
import { createHeldOrder, authorizeOrder, captureAuthorization, voidAuthorization, paypalMock, clientId, cardDemo } from './paypal.js';
import { simulateDispute, findDisputeForCapture, provideEvidence } from './paypal.js';
import { listProfiles, getProfile, updateRules, CATEGORIES } from './profiles.js';
import { catalogSnapshot, signReceipt, evidencePack, usingDevSecret } from './evidence.js';
import { log, count, metrics, requestLogger } from './obs.js';

const PROD = process.env.NODE_ENV === 'production';
if (PROD && usingDevSecret) {
  log('error', 'startup.refused', { reason: 'RECEIPT_SECRET must be set in production (receipts would be signed with a public key)' });
  process.exit(1);
}

const LOG_FILE = dataFile('decisions.json');
const MAX_DECISIONS = 500;

// ---------------- errors & validation ----------------
/** An error whose message is safe to show to the caller. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** Trimmed string from user input, length-capped; '' if missing or not a string/number. */
const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');
const ID = /^[A-Za-z0-9-]{1,64}$/; // UUIDs, PayPal order ids, profile ids
const idParam = (req, name) => (ID.test(req.params[name]) ? req.params[name] : fail(400, `Invalid ${name}.`));

// ---------------- short-lived state (bounded, expires) ----------------
/** A Map with a max size and a time-to-live, so a public server cannot be filled up with abandoned carts. */
function ttlStore(ttlMs, max) {
  const m = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of m) if (v.exp < now) m.delete(k);
    while (m.size > max) m.delete(m.keys().next().value); // oldest first
  };
  setInterval(sweep, 60_000).unref();
  return {
    get: (k) => {
      const v = m.get(k);
      return v && v.exp >= Date.now() ? v.val : undefined;
    },
    set: (k, val) => {
      m.set(k, { val, exp: Date.now() + ttlMs });
      if (m.size > max) sweep();
    },
    delete: (k) => m.delete(k),
  };
}
const HOUR = 3_600_000;
const mandates = ttlStore(6 * HOUR, 5000); // id -> mandate
const runs = ttlStore(6 * HOUR, 5000); // run id -> agent run (kept server-side so the browser cannot edit the cart)
const checkouts = ttlStore(6 * HOUR, 5000); // paypal order id -> { mandate, run } (PayPal holds last up to 29 days, approvals far less)

// ---------------- decision log (persisted) ----------------
function loadDecisions() {
  try {
    return fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
  } catch (e) {
    // A corrupt log must not stop payments: keep a copy for inspection and start fresh.
    const bad = `${LOG_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(LOG_FILE, bad);
    log('error', 'decisions.load_failed', { error: e.message, movedTo: bad });
    return [];
  }
}
const decisions = loadDecisions();
/** Atomic write (temp file + rename), and the in-memory log stays bounded too. */
function saveLog() {
  if (decisions.length > MAX_DECISIONS) decisions.splice(0, decisions.length - MAX_DECISIONS);
  const tmp = `${LOG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(decisions, null, 2));
  fs.renameSync(tmp, LOG_FILE);
}
const findDecision = (id) => decisions.find((x) => x.id === id);

// ---------------- app & middleware ----------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render's proxy: rate limits use the real client IP

app.use(requestLogger);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The PayPal JS SDK loads from paypal.com and renders its buttons in paypal.com iframes.
        scriptSrc: ["'self'", 'https://www.paypal.com', 'https://*.paypal.com'],
        frameSrc: ['https://*.paypal.com'],
        connectSrc: ["'self'", 'https://*.paypal.com'],
        imgSrc: ["'self'", 'data:', 'https://*.paypal.com', 'https://*.paypalobjects.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // animation libraries set inline styles
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // PayPal approval opens a popup that reports back
  }),
);

app.use(express.json({ limit: '100kb' }));

// CSRF: browsers can send cross-site form posts without asking first, but never with a JSON content type.
// Every state-changing API call must therefore be JSON (the UI and the MCP server always send it).
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json'))
    return res.status(415).json({ error: 'Send requests as application/json.' });
  next();
});

// Rate limits: generous for normal use, tight where each call costs Gemini quota or touches PayPal.
const limiter = (windowMs, limit, what) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      count('rate_limited_total', { what });
      res.status(429).json({ error: `Too many ${what} requests. Please wait a minute and try again.` });
    },
  });
app.use('/api', limiter(60_000, 240, 'API'));
const aiLimit = limiter(60_000, 12, 'AI');
const payLimit = limiter(60_000, 30, 'payment');

// The React UI (web/, built to web/dist) when it has been built; otherwise the original plain UI in public/.
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const UI_DIR = fs.existsSync(path.join(WEB_DIST, 'index.html')) ? WEB_DIST : path.join(ROOT, 'public');
app.use('/assets', express.static(path.join(UI_DIR, 'assets'), { immutable: true, maxAge: '1y' })); // hashed file names
app.use(express.static(UI_DIR, { maxAge: 0 }));

// ---------------- health, config, metrics ----------------
app.get('/api/health', (req, res) => res.json({ ok: true, paypal: paypalMock ? 'mock' : 'sandbox', ai: aiMock ? 'offline' : 'gemini' }));

app.get('/api/config', (req, res) => res.json({ paypalMock, cardDemo, aiMock, aiModels: aiMock ? null : aiModels, paypalClientId: clientId }));

// Counters and latencies (no personal data). Protected by METRICS_TOKEN when it is set.
app.get('/api/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token && req.get('authorization') !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
  const outcomes = {};
  for (const d of decisions) outcomes[d.payment?.action ?? 'held'] = (outcomes[d.payment?.action ?? 'held'] ?? 0) + 1;
  res.json({ ...metrics(), decisions_logged: decisions.length, payment_outcomes: outcomes });
});

// ---------------- shops ----------------
app.get('/api/shops', (req, res) => res.json(listShops()));

app.get('/api/shops/:id', (req, res) => {
  const shop = getShop(idParam(req, 'id'));
  if (!shop) fail(404, 'Shop not found');
  res.json({ ...shop, products: shop.products.map(({ checkout_price, ...p }) => ({ ...p, scan: scanListing(shop.id, p) })) });
});

// Shelf: messy product list -> agent-readable shop
app.post(
  '/api/shelf/import',
  aiLimit,
  wrap(async (req, res) => {
    const name = str(req.body?.name, 60).replace(/[<>]/g, '');
    const raw = str(req.body?.products, 20_000);
    if (name.length < 2 || !raw) fail(400, 'A shop name (2-60 characters) and a product list are required.');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `shop-${Date.now()}`;
    // A seller must never be able to replace a verified shop's catalog: the Sentinel checks prices against it.
    if (isProtectedShop(id)) fail(409, 'That name belongs to an existing verified shop. Choose another name.');
    if (!getShop(id) && shelfShopCount() >= MAX_SHELF_SHOPS) fail(409, 'The demo shelf is full. Try again later.');
    const products = await normalizeProducts(raw, id);
    if (!products.length) fail(400, 'No products with a name and price were found.');
    const shop = upsertShop({ id, name, trusted: false, products });
    // Report instructions aimed at AI agents found in the seller's raw text, even if the AI clean-up dropped them.
    const removed = scanRawText(raw);
    count('shelf_imports_total', { flagged: removed.length > 0 });
    log('info', 'shelf.import', { reqId: req.id, shop: id, products: products.length, flaggedLines: removed.length });
    res.status(201).json({ ...shop, removed, products: shop.products.map((p) => ({ ...p, scan: scanListing(id, p) })) });
  }),
);

// ---------------- Guardian mode ----------------
app.get('/api/profiles', (req, res) => res.json({ profiles: listProfiles(), categories: CATEGORIES }));

app.put(
  '/api/profiles/:id/rules',
  wrap(async (req, res) => {
    const id = idParam(req, 'id');
    if (!getProfile(id)?.guardian) fail(404, 'Profile has no guardian');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'Send the rules as a JSON object.');
    const profile = updateRules(id, req.body); // throws HttpError-like { status: 400 } on invalid input
    log('info', 'guardian.rules_updated', { reqId: req.id, profile: id, rules: profile.guardian.rules });
    res.json(profile);
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
  aiLimit,
  wrap(async (req, res) => {
    const text = str(req.body?.text, 500);
    if (text.length < 3) fail(400, 'Tell the agent what to buy.');
    const profile = getProfile(str(req.body?.profileId, 64) || 'self');
    if (!profile) fail(404, 'Unknown profile');
    const mandate = { id: randomUUID(), createdAt: new Date().toISOString(), profileId: profile.id, ...(await extractMandate(text)) };
    mandates.set(mandate.id, mandate);
    count('mandates_total', { parsedBy: mandate.parsedBy ?? 'offline', complete: !mandate.missing.length });
    log('info', 'mandate.created', { reqId: req.id, mandateId: mandate.id, profile: profile.id, parsedBy: mandate.parsedBy, missing: mandate.missing });
    res.status(201).json(mandate);
  }),
);

// ---------------- 2. agent shops ----------------
app.post(
  '/api/mandates/:id/run',
  aiLimit,
  wrap(async (req, res) => {
    const mandate = mandates.get(idParam(req, 'id'));
    if (!mandate) fail(404, 'Mandate not found or expired. Create it again.');
    if (mandate.missing.length) fail(400, `The request is missing ${mandate.missing.join(' and ')}.`);
    const mode = req.body?.agent === 'gemini' ? 'gemini' : 'simulated';
    const run = await runAgent(mandate, { mode, attack: req.body?.attack === true });
    const runId = randomUUID();
    runs.set(runId, { ...run, mandateId: mandate.id });
    count('agent_runs_total', { agent: run.agent, fallback: !!run.fallback });
    log('info', 'agent.run', { reqId: req.id, runId, mandateId: mandate.id, agent: run.agent, model: run.model, fallback: !!run.fallback, items: run.cart.items.length, total: run.cart.total });
    res.json({ runId, ...run });
  }),
);

// ---------------- 2b. outside agents (MCP server) ----------------
// An outside agent sees every shop, like on the open web. Listings are returned as written, hidden text included:
// PaySentinel does not try to make the agent safe, it makes the payment safe.
app.get('/api/search', (req, res) => {
  const q = str(req.query.q, 100);
  if (!q) fail(400, 'Give a search query.');
  res.json(search(q).slice(0, 10).map(({ score, ...r }) => r));
});

app.get('/api/shops/:shop/products/:sku', (req, res) => {
  const p = getProduct(idParam(req, 'shop'), idParam(req, 'sku'));
  if (!p) fail(404, 'Product not found');
  const { checkout_price, ...listing } = p;
  res.json({ shop: req.params.shop, ...listing });
});

app.post(
  '/api/mandates/:id/cart',
  payLimit,
  wrap(async (req, res) => {
    const mandate = mandates.get(idParam(req, 'id'));
    if (!mandate) fail(404, 'Mandate not found or expired. Create it again.');
    if (mandate.missing.length) fail(400, `The mandate is missing ${mandate.missing.join(' and ')}.`);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 20) fail(400, 'Send 1 to 20 items: { shop, sku, quantity }.');
    const clean = items.map((it, i) => {
      if (!it || typeof it !== 'object') fail(400, `Item ${i + 1} must be an object.`);
      const q = Number(it.quantity ?? 1);
      if (!Number.isInteger(q) || q < 1 || q > 100) fail(400, `Item ${i + 1}: quantity must be a whole number from 1 to 100.`);
      return { shop: str(it.shop, 64), sku: str(it.sku, 64), quantity: q, reason: str(it.reason, 200) || undefined };
    });
    const agent = str(req.body?.agent, 40).replace(/[^\w .:-]/g, '') || 'mcp-client';
    const run = externalRun(clean, agent);
    const runId = randomUUID();
    runs.set(runId, { ...run, mandateId: mandate.id });
    count('agent_runs_total', { agent: 'external', fallback: false });
    log('info', 'agent.external_cart', { reqId: req.id, runId, mandateId: mandate.id, agent, items: run.cart.items.length, total: run.cart.total });
    res.status(201).json({ runId, ...run });
  }),
);

// ---------------- 3. hold the money ----------------
app.post(
  '/api/checkout',
  payLimit,
  wrap(async (req, res) => {
    const runId = str(req.body?.runId, 64);
    const run = runs.get(runId);
    if (!run) fail(404, 'Agent run not found or expired. Let the agent shop again.');
    if (!run.cart?.shop || !run.cart.items?.length) fail(400, 'The agent did not put anything in the cart.');
    const mandate = mandates.get(run.mandateId);
    if (!mandate) fail(404, 'The mandate for this cart expired. Create it again.');
    if (run.checkedOut) fail(409, 'This cart was already sent to PayPal. Let the agent shop again.');
    run.checkedOut = true; // one payment per agent run (set before the await so a double click cannot create two orders)
    try {
      const method = req.body?.method === 'card' ? 'card' : 'paypal';
      const { id, approveUrl } = await createHeldOrder(run.cart, { currency: mandate.currency, reference: mandate.id.slice(0, 32), testCard: method === 'card' });
      // Keep the mandate with the checkout: the decision must use the mandate the cart was built for.
      checkouts.set(id, { mandate, run });
      count('orders_created_total', { method });
      log('info', 'order.created', { reqId: req.id, orderId: id, runId, method, total: run.cart.total, shop: run.cart.shop });
      res.status(201).json({ orderId: id, approveUrl: approveUrl ?? null });
    } catch (e) {
      run.checkedOut = false; // PayPal did not create the order, so the cart can be retried
      throw e;
    }
  }),
);

// ---------------- 4. buyer approved: authorize, verify, decide ----------------
app.post(
  '/api/orders/:orderId/authorize',
  payLimit,
  wrap(async (req, res) => {
    const orderId = idParam(req, 'orderId');
    const pending = checkouts.get(orderId);
    if (!pending) fail(404, 'Unknown or already processed checkout.');
    if (pending.processing) fail(409, 'This payment is already being processed.');
    pending.processing = true; // a double click (or a retrying agent) must not authorize and capture twice
    try {
      const { mandate, run } = pending;
      const profile = getProfile(mandate.profileId);
      const guardian = profile?.guardian ? { ...profile.guardian, spentThisWeek: spentThisWeek(profile.id) } : null;

      const held = await authorizeOrder(orderId); // what PayPal actually holds
      let result;
      try {
        result = verify(mandate, held, guardian); // fixed rules, no AI
      } catch (e) {
        // Fail closed: if the checks themselves break, release the money instead of leaving it held unchecked.
        await voidAuthorization(held.authorizationId).catch((ve) => log('error', 'payment.void_failed', { orderId, error: ve.message }));
        throw e;
      }

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
        agent: run.agent,
        trace: run.trace,
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
      checkouts.delete(orderId);

      const failed = result.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}:${c.status}`);
      count('decisions_total', { decision: result.decision, guardian: !!guardian });
      for (const c of result.checks) if (c.status !== 'pass') count('checks_failed_total', { check: c.id, status: c.status });
      log('info', 'payment.decided', { reqId: req.id, decisionId: decision.id, orderId, decision: result.decision, payment: payment.action ?? 'held', total: held.total, shop: held.shop, failed });
      res.json(decision);
    } finally {
      pending.processing = false;
    }
  }),
);

// ---------------- 5. shopper resolves a borderline order ----------------
app.post(
  '/api/decisions/:id/:action(approve|reject)',
  payLimit,
  wrap(async (req, res) => {
    const d = findDecision(idParam(req, 'id'));
    if (!d) fail(404, 'Decision not found');
    if (d.decision !== 'review' || d.resolvedBy || d.resolving) fail(409, 'This payment is not waiting for approval.');
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
    count('reviews_resolved_total', { action: req.params.action, by: d.resolvedBy });
    log('info', 'payment.resolved', { reqId: req.id, decisionId: d.id, action: req.params.action, by: d.resolvedBy });
    res.json(d);
  }),
);

app.get('/api/decisions', (req, res) => res.json([...decisions].reverse()));

app.get('/api/decisions/:id', (req, res) => {
  const d = findDecision(idParam(req, 'id'));
  if (!d) fail(404, 'Decision not found');
  res.json(d);
});

// ---------------- 6. disputes: answer with the signed evidence pack ----------------
app.get('/api/decisions/:id/evidence', (req, res) => {
  const d = findDecision(idParam(req, 'id'));
  if (!d) fail(404, 'Decision not found');
  res.json(evidencePack(d));
});

const capturedDecision = (req) => {
  const d = findDecision(idParam(req, 'id'));
  if (!d) fail(404, 'Decision not found');
  if (d.payment?.action !== 'captured') fail(409, 'Only captured payments can be disputed.');
  return d;
};

// Mock mode only: a buyer says "my AI assistant bought this without my permission".
// In sandbox, open the dispute as the sandbox buyer in the PayPal Resolution Center instead.
app.post(
  '/api/decisions/:id/dispute/simulate',
  wrap(async (req, res) => {
    const d = capturedDecision(req);
    if (!paypalMock) fail(409, 'In sandbox, open the dispute as the buyer in the PayPal sandbox Resolution Center, then press "Find dispute".');
    d.dispute = simulateDispute(d.payment.id, d.order.total, d.order.currency);
    saveLog();
    res.json(d.dispute);
  }),
);

app.post(
  '/api/decisions/:id/dispute/find',
  payLimit,
  wrap(async (req, res) => {
    const d = capturedDecision(req);
    const found = await findDisputeForCapture(d.payment.id);
    if (!found) fail(404, 'No dispute found for this payment yet (sandbox disputes can take a few minutes to appear).');
    d.dispute = { ...d.dispute, ...found };
    saveLog();
    log('info', 'dispute.found', { reqId: req.id, decisionId: d.id, disputeId: found.dispute_id, reason: found.reason, stage: found.stage });
    res.json(d.dispute);
  }),
);

app.post(
  '/api/decisions/:id/dispute/draft',
  aiLimit,
  wrap(async (req, res) => {
    const d = findDecision(idParam(req, 'id'));
    if (!d?.dispute) fail(404, 'No dispute on this payment.');
    res.json({ notes: await draftDisputeResponse(d.dispute, evidencePack(d)) });
  }),
);

app.post(
  '/api/decisions/:id/dispute/submit',
  payLimit,
  wrap(async (req, res) => {
    const d = findDecision(idParam(req, 'id'));
    if (!d?.dispute) fail(404, 'No dispute on this payment.');
    const notes = str(req.body?.notes, 2000);
    if (notes.length < 20) fail(400, 'Write or draft a response first (at least 20 characters).');
    if (d.dispute.submitting) fail(409, 'The response is already being sent.');
    d.dispute.submitting = true;
    try {
      const r = await provideEvidence(d.dispute.dispute_id, notes, evidencePack(d));
      d.dispute = { ...d.dispute, status: r.status, channel: r.channel ?? null, evidence_type: r.evidenceType ?? null, response: notes, responded_at: new Date().toISOString() };
    } finally {
      delete d.dispute.submitting;
    }
    saveLog();
    count('dispute_responses_total', { channel: d.dispute.channel ?? 'mock' });
    log('info', 'dispute.responded', { reqId: req.id, decisionId: d.id, disputeId: d.dispute.dispute_id, channel: d.dispute.channel, evidenceType: d.dispute.evidence_type });
    res.json(d.dispute);
  }),
);

// ---------------- fallbacks & errors ----------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err.expose && err.status < 500) return res.status(err.status).json({ error: err.message });
  // Upstream failures (PayPal, Gemini) carry a useful, secret-free message; anything else stays generic.
  const upstream = /^(PayPal|Gemini)\b/.test(err.message ?? '');
  const status = upstream ? 502 : 500;
  count('errors_total', { status, upstream });
  log('error', 'http.error', { reqId: req.id, method: req.method, path: req.path, status, error: err.message, stack: PROD ? undefined : err.stack });
  res.status(status).json({ error: upstream ? err.message.slice(0, 400) : 'Something went wrong on our side.', requestId: req.id });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  log('info', 'startup', {
    url: `http://localhost:${port}`,
    paypal: paypalMock ? 'mock (set PAYPAL_CLIENT_ID/SECRET for sandbox)' : 'sandbox',
    ai: aiMock ? 'offline heuristics (set GEMINI_API_KEY)' : 'gemini',
    cardDemo,
    ui: path.relative(ROOT, UI_DIR),
    receiptKey: usingDevSecret ? 'DEV KEY (set RECEIPT_SECRET)' : 'configured',
  });
});

// Graceful shutdown (Render sends SIGTERM on deploy): finish in-flight requests, then exit.
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    log('info', 'shutdown', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
process.on('unhandledRejection', (e) => log('error', 'unhandled_rejection', { error: String(e?.message ?? e) }));
