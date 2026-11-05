// Gemini (free tier) via REST. Every model output is validated; nothing here decides about money.
const KEY = process.env.GEMINI_API_KEY;
// Free-tier models get overloaded (503) and have small per-minute quotas (429), so:
//  - the shopping agent (many calls in a row) gets the main model's quota to itself,
//  - short one-shot jobs (mandate, explanations, drafts) use a lighter model with its own quota,
//  - every list falls back to the next model, and a rate-limited call waits briefly and retries.
const MAIN = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const LIGHT = process.env.GEMINI_LIGHT_MODEL || 'gemini-3.1-flash-lite';
// Free-tier quotas are per model (some only ~20 requests a day), so spreading work over several models
// multiplies what the demo can do in a day.
const AGENT_MODELS = [...new Set([MAIN, 'gemini-3-flash-preview', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-flash-latest', LIGHT, 'gemini-flash-lite-latest'])];
const TASK_MODELS = [...new Set([LIGHT, 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', MAIN])];
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25_000;
export const aiMock = !KEY;
export const aiModels = { agent: MAIN, tasks: LIGHT };
export { AGENT_MODELS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Models that recently failed with a quota or overload error, and when to try them again.
const cooldown = new Map();
const usable = (list) => list.filter((m) => (cooldown.get(m) ?? 0) <= Date.now());
const coolDown = (model, err) => cooldown.set(model, Date.now() + (err.status === 429 ? Math.min(err.retryAfterMs ?? 60_000, 3_600_000) : 60_000));

async function callModel(model, body) {
  const gc = { ...body.generationConfig };
  if (/gemini-3/.test(model)) {
    gc.thinkingConfig ??= { thinkingLevel: 'low' }; // keep the demo snappy
    delete gc.temperature; // Gemini 3 is tuned for its default temperature
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ ...body, generationConfig: gc }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gemini ${model} failed (${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    err.retryable = [404, 429, 500, 502, 503, 504].includes(res.status);
    const delay = text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1];
    err.retryAfterMs = delay ? Number(delay) * 1000 : 5000;
    err.daily = res.status === 429 && (/PerDay/.test(text) || err.retryAfterMs > 60_000);
    throw err;
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content;
  if (!content) throw new Error(`Gemini returned no content (${data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? 'unknown'})`);
  return content;
}

const isRetryable = (e) => e.retryable || e.name === 'TimeoutError';

/**
 * One generateContent call. Returns { content, model }.
 * Without `model`: tries each usable model in `models` until one answers.
 * With `model`: stays on that model (a function-calling conversation must not switch models midway);
 * a short per-minute rate limit is waited out, anything longer is thrown so the caller can restart elsewhere.
 */
export async function geminiCall(body, { model, models = AGENT_MODELS } = {}) {
  if (model) {
    let waited = 0;
    for (;;) {
      try {
        return { content: await callModel(model, body), model };
      } catch (e) {
        if (!isRetryable(e) || e.daily || waited >= 20_000) {
          if (isRetryable(e)) coolDown(model, e);
          throw e;
        }
        const ms = Math.min(e.retryAfterMs ?? 3000, 20_000 - waited);
        waited += ms + 1;
        await sleep(ms);
      }
    }
  }
  let last = new Error('All Gemini models are busy or out of free quota right now.');
  for (const m of usable(models)) {
    try {
      return { content: await callModel(m, body), model: m };
    } catch (e) {
      if (!isRetryable(e)) throw e;
      coolDown(m, e);
      last = e;
    }
  }
  throw last;
}

/** Models the agent can still use right now, best first. */
export const agentModels = () => usable(AGENT_MODELS);

export async function gemini(body) {
  return (await geminiCall(body)).content;
}

async function geminiJSON(prompt, responseSchema) {
  const { content } = await geminiCall(
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0.1 } },
    { models: TASK_MODELS },
  );
  const text = content.parts?.map((p) => p.text ?? '').join('') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

import { stem, vocabulary } from './catalog.js';

// ---------------- mandate ----------------
export function validateMandate(m, text) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const quantity = Math.max(1, Math.round(num(m.quantity, 1)));
  const must_match = [...new Set((m.must_match ?? []).map((k) => stem(String(k).trim())).filter((k) => k.length >= 2))].slice(0, 4);
  const max_unit_price = num(m.max_unit_price, null);
  const max_total = num(m.max_total, max_unit_price ? max_unit_price * quantity : null);
  const missing = [];
  if (!must_match.length) missing.push('what to buy');
  if (!max_total) missing.push('a price limit');
  return {
    request: text,
    summary: String(m.summary ?? text).slice(0, 200),
    must_match,
    quantity,
    max_unit_price: max_unit_price ?? max_total,
    max_total,
    currency: /^[A-Z]{3}$/.test(m.currency ?? '') ? m.currency : 'USD',
    allowed_shops: Array.isArray(m.allowed_shops) ? m.allowed_shops.map(String) : [],
    missing,
  };
}

/** Plain English -> strict mandate the Sentinel enforces. */
export async function extractMandate(text) {
  if (aiMock) return validateMandate(heuristicMandate(text), text);
  let m;
  try {
    m = await geminiJSON(
    `Turn this shopping request into a strict purchase mandate for an AI shopping agent.
- must_match: 1-3 short lowercase keywords that EVERY acceptable product name must contain (e.g. "aa", "battery"). Be specific: "aa" not "aaa".
- quantity: number of packs/units requested (default 1).
- max_unit_price and max_total: price limits in the user's currency. If only one limit is given, use it for both scaled by quantity.
- allowed_shops: shop ids only if the user names specific shops, else [].
- summary: one short line restating the request.
Never invent a price limit; use 0 if none is given.

Request: """${text}"""`,
    {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        must_match: { type: 'ARRAY', items: { type: 'STRING' } },
        quantity: { type: 'INTEGER' },
        max_unit_price: { type: 'NUMBER' },
        max_total: { type: 'NUMBER' },
        currency: { type: 'STRING' },
        allowed_shops: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['summary', 'must_match', 'quantity', 'max_unit_price', 'max_total', 'currency', 'allowed_shops'],
    },
  );
  } catch (e) {
    console.warn(`Mandate: Gemini unavailable, using the offline parser (${e.message.slice(0, 120)})`);
    return { ...validateMandate(heuristicMandate(text), text), parsedBy: 'offline' };
  }
  return { ...validateMandate(m, text), parsedBy: 'gemini' };
}

const WORDS = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5 };
const STOP = new Set('buy get me order find a an the of for from under below less than max up to pack packs please some with and or my cheap cheapest trusted shop store one two three four five'.split(' '));

function heuristicMandate(text) {
  const t = text.toLowerCase();
  const price = Number(t.match(/(?:under|below|less than|max(?:imum)?|up to|within)\s*\$?\s*(\d+(?:\.\d+)?)/)?.[1]) || 0;
  const q = t.match(/\b(\d+|one|a|an|two|three|four|five)\s+(?:packs?|units?|x|boxes?|sets?|bags?|bottles?|pieces?|items?)\b/)?.[1];
  const quantity = WORDS[q] ?? (Number(q) || 1);
  const vocab = vocabulary();
  const must_match = t
    .replace(/\$?\d+(\.\d+)?/g, ' ')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && vocab.has(stem(w)) && !/^(kg|mg|usd|bag|pack|tablet|piece|box|bottle)$/.test(stem(w)));
  return { summary: text, must_match, quantity, max_unit_price: price, max_total: price * quantity, currency: 'USD', allowed_shops: [] };
}

// ---------------- explanation ----------------
export async function explainDecision(mandate, order, result) {
  const failed = result.checks.filter((c) => c.status !== 'pass');
  const SHORT = {
    shop: 'the shop is not verified',
    catalog: 'items are not in the shop catalog',
    intent: 'the cart has an item you did not ask for',
    injection: 'hidden text in a listing planted an item',
    price: 'a price changed at checkout',
    quantity: 'the quantity is different',
    budget: 'the total is over your budget',
    total: 'the held amount does not match the items',
    g_category: 'the guardian does not allow this kind of purchase',
    g_shop: 'the guardian only allows verified shops',
    g_order: 'it is over the guardian\'s per-order limit',
    g_week: 'it is over the guardian\'s weekly budget',
  };
  const list = failed.map((c) => SHORT[c.id] ?? c.label);
  const fallback =
    result.decision === 'capture'
      ? `All ${result.checks.length} checks passed, so the payment was captured.`
      : `${result.decision === 'void' ? 'Blocked, and the held money was released' : 'Waiting for your approval'}: ${list.join('; ')}.`;
  if (aiMock) return fallback;
  try {
    const r = await geminiJSON(
      `Explain this payment decision to the shopper in at most 2 short, plain sentences. No jargon, no markdown.
Request: "${mandate.request}"
Decision: ${result.decision} (capture = the payment has ALREADY been charged; review = the money is on hold until the shopper or guardian decides; void = blocked and the hold released, nothing charged). Describe what already happened; never say a charge is coming later.
Findings: ${JSON.stringify(failed.length ? failed : result.checks.slice(0, 3))}`,
      { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] },
    );
    return String(r.text || fallback).slice(0, 400);
  } catch {
    return fallback; // explanation is cosmetic; never fail the payment flow over it
  }
}

// ---------------- dispute response ----------------
/** Draft the seller's response to a dispute from the signed evidence pack. The seller reviews it before sending. */
export async function draftDisputeResponse(dispute, pack) {
  const passed = pack.checks.filter((c) => c.status === 'pass').length;
  const fallback = [
    `This purchase was made by an AI shopping agent acting for the buyer (${pack.on_behalf_of}), under the buyer's own instruction: "${pack.request}".`,
    `Before any money was taken, PayPal only held the payment (authorization ${pack.paypal.authorization_id}). PaySentinel then checked the order against that instruction: ${passed} of ${pack.checks.length} checks passed${pack.resolved_by === 'sentinel' ? '' : `, and ${pack.approver} approved it`}.`,
    `The items, quantity and price (${pack.order.currency} ${Number(pack.order.total).toFixed(2)}) match the instruction and the shop's listed prices at the time. The attached evidence pack is signed (SHA-256 ${pack.receipt?.sha256?.slice(0, 16)}…).`,
  ].join(' ');
  if (aiMock) return fallback;
  try {
    const r = await geminiJSON(
      `You are writing a seller's response to a PayPal dispute. Be factual, calm and under 150 words. Use only the facts below; do not invent shipping or tracking details.
Dispute reason: ${dispute.reason}. Buyer said: "${dispute.buyer_message ?? 'n/a'}"
Evidence pack: ${JSON.stringify({ request: pack.request, on_behalf_of: pack.on_behalf_of, approver: pack.approver, resolved_by: pack.resolved_by, paypal: pack.paypal, order: pack.order, checks: pack.checks, receipt_sha256: pack.receipt?.sha256 })}`,
      { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] },
    );
    return String(r.text || fallback).slice(0, 2000);
  } catch {
    return fallback;
  }
}

// ---------------- Shelf import ----------------
/** Messy product rows (CSV text or notes) -> clean catalog products. */
export async function normalizeProducts(raw, shopId) {
  const rows = aiMock
    ? heuristicProducts(raw)
    : (await geminiJSON(
        `Convert this seller's product list into clean catalog entries for AI shopping agents.
Keep every product. Use clear, descriptive names (brand-free unless given), a numeric price, an integer stock (default 10), and a one-sentence factual description.
Do not invent products or prices. Copy any text the seller wrote into the description only if it describes the product.

Product list:
"""${raw.slice(0, 8000)}"""`,
        {
          type: 'OBJECT',
          properties: {
            products: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { name: { type: 'STRING' }, price: { type: 'NUMBER' }, stock: { type: 'INTEGER' }, description: { type: 'STRING' } },
                required: ['name', 'price', 'stock', 'description'],
              },
            },
          },
          required: ['products'],
        },
      )).products;
  return rows
    .filter((r) => r.name && Number(r.price) > 0)
    .slice(0, 200)
    .map((r, i) => ({
      sku: `${shopId.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
      name: String(r.name).slice(0, 120),
      price: Math.round(Number(r.price) * 100) / 100,
      stock: Math.max(0, Math.round(Number(r.stock) || 10)),
      description: String(r.description ?? '').slice(0, 1000),
    }));
}

function heuristicProducts(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines[0]?.toLowerCase().includes('price') ? lines.shift().toLowerCase().split(',') : ['name', 'price', 'stock', 'description'];
  const col = (n) => header.findIndex((h) => h.trim().startsWith(n));
  return lines.map((l) => {
    const c = l.split(',');
    return { name: c[col('name')], price: c[col('price')]?.replace(/[^\d.]/g, ''), stock: c[col('stock')], description: c.slice(Math.max(col('desc'), 0) || 3).join(',') };
  });
}
