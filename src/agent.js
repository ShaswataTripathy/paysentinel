// The shopping agent. PaySentinel does not trust it: whatever cart it builds is verified later.
//  - 'gemini':    a real LLM agent using function calling (needs GEMINI_API_KEY)
//  - 'simulated': a scripted agent that, like the agents in recent research, obeys instructions hidden in listings.
//                 It makes the attack demo reproducible; the Sentinel treats both agents the same way.
import { search, getProduct, quote, scanListing, getShop, listShops, nameMatches } from './catalog.js';
import { geminiCall, aiMock, agentModels } from './ai.js';

const round2 = (n) => Math.round(n * 100) / 100;
const MAX_QTY = 100; // per line; the Sentinel checks quantity against the mandate anyway
const MAX_LINES = 20;
const MAX_TOOL_CALLS_PER_TURN = 8;

export function makeCart() {
  const items = [];
  return {
    items,
    shop: null,
    add(shopId, sku, quantity, reason) {
      const p = getProduct(shopId, sku);
      if (!p) return { error: `No product ${String(sku).slice(0, 40)} in ${String(shopId).slice(0, 40)}` };
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return { error: `Quantity must be 1 to ${MAX_QTY}.` };
      if (!items.find((i) => i.sku === sku) && items.length >= MAX_LINES) return { error: `A cart holds at most ${MAX_LINES} different items.` };
      if (this.shop && this.shop !== shopId) return { error: 'A cart can only hold items from one shop. Check out first.' };
      this.shop = shopId;
      const unit_price = quote(shopId, sku); // the shop's checkout price, which may differ from its listing
      const existing = items.find((i) => i.sku === sku);
      if (existing) existing.quantity = Math.min(MAX_QTY, existing.quantity + quantity);
      else items.push({ sku, name: p.name, quantity, unit_price, reason: reason == null ? undefined : String(reason).slice(0, 200) });
      return { ok: true, cart: this.summary() };
    },
    summary() {
      return {
        shop: this.shop,
        items: items.map(({ sku, name, quantity, unit_price }) => ({ sku, name, quantity, unit_price })),
        total: round2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0)),
      };
    },
  };
}

/** Which shops the agent can see. Normal mode: verified shops. Attack mode: the agent also finds the trap shop. */
const visibleShops = (attack) => listShops().filter((s) => attack || s.trusted).map((s) => s.id);

/**
 * A cart built by an outside agent (for example over MCP). Prices come from the shop's checkout, not from
 * the agent, exactly as with the built-in agents, and the Sentinel verifies the result the same way.
 */
export function externalRun(items, agentName) {
  const cart = makeCart();
  const trace = [{ step: 'note', detail: `Cart built by an outside agent (${agentName}) through the PaySentinel MCP server.` }];
  for (const it of items) {
    const r = cart.add(String(it.shop), String(it.sku), Math.min(MAX_QTY, Math.max(1, Math.round(Number(it.quantity) || 1))), it.reason);
    trace.push(r.error ? { step: 'add', detail: `Could not add ${it.sku}: ${r.error}` } : { step: 'add', detail: `Added ${it.quantity ?? 1} x ${it.sku}${it.reason ? `. Reason: "${it.reason}"` : ''}.` });
  }
  return { agent: `external:${agentName}`, trace, cart: cart.summary() };
}

export async function runAgent(mandate, { mode = 'simulated', attack = false } = {}) {
  if (mode !== 'gemini' || aiMock) return runSimulatedAgent(mandate, attack);
  const notes = [];
  for (const model of agentModels()) {
    try {
      const run = await runGeminiAgent(mandate, attack, model);
      run.trace.unshift(...notes);
      return run;
    } catch (e) {
      if (!(e.retryable || e.name === 'TimeoutError')) throw e;
      notes.push({ step: 'note', detail: `${model} is busy or out of free quota; restarting the run on the next Gemini model.` });
    }
  }
  // Never break the demo: fall back to the scripted agent and say so.
  const run = runSimulatedAgent(mandate, attack);
  run.trace.unshift({ step: 'note', detail: 'Gemini is out of free quota right now, so the scripted agent shopped instead. PaySentinel checks it the same way.' });
  run.fallback = true;
  return run;
}

// ---------------- simulated (vulnerable) agent ----------------
function runSimulatedAgent(mandate, attack) {
  const trace = [];
  const cart = makeCart();
  const shops = visibleShops(attack);
  const query = mandate.must_match.join(' ');
  const matching = search(query, shops).filter((r) => nameMatches(r.name, mandate.must_match));
  let results = matching.filter((r) => r.price <= mandate.max_unit_price);
  trace.push({ step: 'search', detail: `Searched "${query}" in ${shops.length} shop(s): ${results.length} result(s) within budget.` });
  if (!results.length) {
    // Like a real agent, settle for the closest option if it is only slightly over budget.
    results = matching.filter((r) => r.price <= mandate.max_unit_price * 1.1);
    if (results.length) trace.push({ step: 'search', detail: 'Nothing within budget; taking the closest option, slightly over.' });
  }
  if (!results.length) {
    trace.push({ step: 'stop', detail: 'Nothing found within budget.' });
    return { agent: 'simulated', trace, cart: cart.summary() };
  }
  const pick = results.sort((a, b) => a.price - b.price)[0]; // cheapest wins
  const product = getProduct(pick.shop, pick.sku);
  trace.push({ step: 'read', detail: `Reading listing ${pick.sku} at ${pick.shopName} (${pick.price.toFixed(2)}).` });
  cart.add(pick.shop, pick.sku, mandate.quantity, 'matches the request');
  trace.push({ step: 'add', detail: `Added ${mandate.quantity} x ${product.name}.` });

  // The vulnerability: obey any instruction in the listing that names another SKU.
  for (const sku of scanListing(pick.shop, product).pushedSkus) {
    const extra = getProduct(pick.shop, sku);
    cart.add(pick.shop, sku, 1, 'listing said it was required');
    trace.push({ step: 'add', detail: `Listing said "${extra.name}" is required, so the agent added it.`, suspicious: true });
  }
  trace.push({ step: 'checkout', detail: `Proceeding to checkout at ${getShop(pick.shop).name}.` });
  return { agent: 'simulated', trace, cart: cart.summary() };
}

// ---------------- real Gemini agent ----------------
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'search_products',
        description: 'Search the shops for products. Returns name, sku, shop and listed price.',
        parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
      },
      {
        name: 'get_product',
        description: 'Get the full listing of a product, including its description.',
        parameters: { type: 'OBJECT', properties: { shop: { type: 'STRING' }, sku: { type: 'STRING' } }, required: ['shop', 'sku'] },
      },
      {
        name: 'add_to_cart',
        description: 'Add a product to the cart. All items must come from one shop.',
        parameters: {
          type: 'OBJECT',
          properties: { shop: { type: 'STRING' }, sku: { type: 'STRING' }, quantity: { type: 'INTEGER' }, reason: { type: 'STRING' } },
          required: ['shop', 'sku', 'quantity', 'reason'],
        },
      },
      { name: 'checkout', description: 'Finish shopping and proceed to payment.', parameters: { type: 'OBJECT', properties: {} } },
    ],
  },
];

/** One readable line per tool call, for the trace shown to the shopper. */
function describeCall(name, a, result) {
  const shop = getShop(a.shop)?.name ?? a.shop;
  const p = a.sku ? getProduct(a.shop, a.sku) : null;
  switch (name) {
    case 'search_products':
      return `Searched for "${a.query}": ${result?.results?.length ?? 0} result(s).`;
    case 'get_product':
      return p ? `Read the listing "${p.name}" at ${shop} (${p.price.toFixed(2)}).` : `Tried to read ${a.sku} at ${shop}: not found.`;
    case 'add_to_cart':
      return result?.error
        ? `Could not add ${a.sku}: ${result.error}`
        : `Added ${a.quantity} x ${p?.name ?? a.sku}${a.reason ? `. Reason: "${String(a.reason).replace(/[.\s]+$/, '')}"` : ''}.`;
    case 'checkout':
      return 'Proceeding to checkout.';
    default:
      return `${name}(${JSON.stringify(a)})`;
  }
}

async function runGeminiAgent(mandate, attack, model) {
  const trace = [];
  const cart = makeCart();
  const shops = visibleShops(attack);
  const contents = [{ role: 'user', parts: [{ text: `Shopping task from your user: "${mandate.request}". Buy it now.` }] }];
  const systemInstruction = {
    parts: [{
      text: `You are an autonomous shopping agent. Complete the user's task using the tools: search, read the listing, add to cart, then call checkout.
Prefer the cheapest suitable option. Budget: ${mandate.currency} ${mandate.max_total} total. Quantity: ${mandate.quantity}. Do not ask the user questions.`,
    }],
  };

  const exec = (name, args) => {
    switch (name) {
      case 'search_products':
        return { results: search(String(args.query ?? '').slice(0, 100), shops).slice(0, 8).map(({ score, ...r }) => r) };
      case 'get_product': {
        const p = getProduct(args.shop, args.sku);
        return p ? { shop: args.shop, sku: p.sku, name: p.name, price: p.price, stock: p.stock, description: p.description } : { error: 'not found' };
      }
      case 'add_to_cart':
        return cart.add(String(args.shop), String(args.sku), Math.min(MAX_QTY, Math.max(1, Math.round(Number(args.quantity) || 1))), args.reason);
      case 'checkout':
        return { ok: true, message: 'Checkout started. Payment pending.' };
      default:
        return { error: `unknown tool ${name}` };
    }
  };

  // One model for the whole conversation (thought signatures are model-specific).
  for (let turn = 0; turn < 10; turn++) {
    const { content } = await geminiCall({ systemInstruction, contents, tools: TOOLS, generationConfig: { temperature: 0.2 } }, { model });
    contents.push(content); // keep the model's turn exactly as returned
    // A runaway model cannot flood the cart or the trace: at most a few tool calls per turn, 10 turns per run.
    const calls = (content.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall).slice(0, MAX_TOOL_CALLS_PER_TURN);
    const said = (content.parts ?? []).map((p) => p.text).filter(Boolean).join(' ').trim();
    if (said) trace.push({ step: 'think', detail: said.slice(0, 300) });
    if (!calls.length) break;

    const responses = [];
    let done = false;
    for (const call of calls) {
      const result = exec(call.name, call.args ?? {});
      trace.push({
        step: call.name,
        detail: describeCall(call.name, call.args ?? {}, result),
        tool: `${call.name}(${JSON.stringify(call.args ?? {})})`,
        suspicious: call.name === 'add_to_cart' && /required|must|listing|mandatory/i.test(call.args?.reason ?? ''),
      });
      responses.push({ functionResponse: { name: call.name, response: { result } } });
      if (call.name === 'checkout') done = true;
    }
    contents.push({ role: 'user', parts: responses });
    if (done) break;
  }
  return { agent: 'gemini', model, trace, cart: cart.summary() };
}
