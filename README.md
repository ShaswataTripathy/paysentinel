# PaySentinel

**Let AI agents shop with your PayPal, but never unwatched.**

AI shopping agents can be tricked: hidden text in a product listing, a price that changes at checkout, an extra item slipped into the cart. PaySentinel stands between the agent and your money. Every agent payment is **held** with PayPal, **checked** against what you actually asked for, then **captured**, **sent to you for approval**, or **voided**.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## For judges: try it in 2 minutes

- **Live demo:** _URL added after deployment_ (Render free tier: the first load can take ~50 s while it wakes up).
- **Approve without a PayPal login:** in step 3, press **"Approve with a PayPal sandbox test card"**. PayPal's real sandbox places the hold on PayPal's published test Visa, and the rest of the flow (authorize → checks → capture/void) is the real sandbox API.
- **Or approve with PayPal:** press the PayPal button and log in with the sandbox buyer below.

| Sandbox buyer (test money only) | |
|---|---|
| Email | _added before submission_ |
| Password | _added before submission_ |

Suggested path: run **"Buy one pack of AA batteries under $15"** once normally (captured), once with **Attack mode** on (voided, with the reason), then switch to **Mom** and try the gift-card scam example (blocked by the guardian's rules).

Gemini's free tier allows only a few requests per model per day, so PaySentinel spreads work over several Gemini models, and if all are used up the scripted agent shops instead (the trace says so). The Sentinel checks both agents the same way.

## How it works

1. **Intent → mandate.** You tell the agent what to buy in plain English. AI turns it into a strict mandate: what the item must be, quantity, price limits, allowed shops.
2. **The agent shops** (live Gemini agent with tools, or a scripted agent that reproduces the attacks from recent research).
3. **PayPal holds the money.** The order is created with `intent: AUTHORIZE`, so funds are reserved, not charged.
4. **The Sentinel checks** what PayPal actually holds against the mandate and the shop's public catalog, using fixed rules. AI never makes the money decision.
5. **Decision:** all checks pass → capture. Slightly over budget or unverified shop → ask the shopper. Anything else → void, money released.
6. **Every decision is logged** with the rule that made it.

### The checks

| Check | Catches |
|---|---|
| Shop is trusted / allowed | Agent wandered to an unverified or forbidden shop |
| Items exist in the catalog | Made-up or swapped items |
| Only items you asked for | Wrong product (e.g. AAA instead of AA), extra items |
| No items planted by listing text | Prompt injection hidden in product descriptions |
| Charged price = listed price | Price drift at checkout |
| Quantity as requested | Over- or under-buying |
| Within your budget | Overspending (≤10% over asks you; more is blocked) |
| Held amount = item total | Tampered totals |

### Guardian mode

AI assistants will increasingly shop for older parents, and older adults are the people scammers target most. In Guardian mode a family member sets rules for a parent's assistant, and PaySentinel enforces them at payment time, **on top of** whatever the parent asked for:

| Guardian rule | Effect |
|---|---|
| Allowed categories (e.g. groceries, pharmacy, household) | Anything else goes to the guardian for approval |
| Always-blocked categories (e.g. gift cards) | Voided, guardian alerted, even if the parent asked for it |
| Per-order limit | Larger orders are held until the guardian approves |
| Weekly budget | Counts captured payments over the last 7 days |
| Verified shops only | Unverified shops are blocked |

The money stays on hold with PayPal while the guardian decides in the **Guardian** tab: approve (capture) or reject (void).

### Disputes: signed evidence for agent purchases

AI-agent purchases leave no device or IP trail, so "my assistant bought this without my permission" is hard for a merchant to answer. PaySentinel already knows the answer. Every final decision gets a **signed receipt** (SHA-256 + HMAC over the instruction, the order PayPal held, the catalog prices at that moment, every check result and who approved it). Any later edit breaks the signature.

When a buyer disputes a captured payment:
1. **Find the dispute** (`GET /v1/customer/disputes?disputed_transaction_id=…`), or simulate one in mock mode.
2. **AI drafts the response** from the evidence pack only, with no invented facts.
3. The seller edits it and **sends it to PayPal** with the evidence pack attached. PaySentinel reads which evidence PayPal is requesting from the seller (for example `PROOF_OF_FULFILLMENT`) and submits that type with `provide-evidence`; if the case is at a stage where PayPal no longer takes evidence, it answers in the case thread with `send-message` instead.

Tested end to end in the PayPal sandbox: a buyer's case was found by capture ID, Gemini drafted the reply from the signed pack, and PayPal accepted it.

PayPal's Agent Toolkit can list, read and accept disputes but has no tool to submit evidence; this fills that gap.

### Read aloud

Before approval, the payment is summarised in plain words ("You are about to approve 12.99 US dollars to CareCorner…"), with a **Read aloud** button using the browser's speech synthesis. It is on by default for guarded profiles. Screen-reader users otherwise often hear the amount only after paying.

### PaySentinel Shelf

Sellers paste a product list in any format; AI turns it into a clean, agent-readable catalog, and every listing is scanned for hidden instructions aimed at AI agents.

## Any AI agent can pay through PaySentinel (MCP server)

PaySentinel ships an [MCP](https://modelcontextprotocol.io) server, so any MCP-capable agent (Claude Desktop, Claude Code, Cursor, an agent built with PayPal's Agent Toolkit…) can shop and pay with the same protection: PayPal holds the money, PaySentinel checks it against the user's mandate, then captures, holds for approval, or voids. The agent never decides about money.

| Tool | What it does |
|---|---|
| `create_mandate` | The user's own words → strict mandate (call first) |
| `search_products`, `get_product` | Browse shops; listings come back as written, hidden text included, and are marked untrusted |
| `checkout` | Cart → PayPal hold → PaySentinel decision. `test_card` finishes at once (sandbox); `paypal` returns an approval link |
| `complete_payment` | After the user approves on PayPal: place the hold and decide |
| `get_decision` | Check a payment that is waiting for approval |

Add it to Claude Code (PaySentinel must be running, locally or hosted):

```bash
claude mcp add paysentinel --env PAYSENTINEL_URL=http://localhost:3000 -- node /path/to/paysentinel/src/mcp.js
```

Or to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paysentinel": {
      "command": "node",
      "args": ["/path/to/paysentinel/src/mcp.js"],
      "env": { "PAYSENTINEL_URL": "http://localhost:3000", "PAYSENTINEL_AGENT_NAME": "claude-desktop" }
    }
  }
}
```

Then ask the agent: *"Use PaySentinel to buy one pack of AA batteries under $15."* Payments made over MCP appear in the Decision log tagged **via MCP**. `npm run mcp:smoke` runs an honest purchase (captured) and a hijacked one (voided) through the MCP server.

## PayPal integration

| Step | API |
|---|---|
| Auth | `POST /v1/oauth2/token` |
| Hold | `POST /v2/checkout/orders` with `intent: AUTHORIZE`, buyer approval via PayPal JavaScript SDK (or a sandbox test card in `payment_source.card` for one-click judging) |
| Place the hold | `POST /v2/checkout/orders/{id}/authorize` |
| Charge | `POST /v2/payments/authorizations/{id}/capture` |
| Release | `POST /v2/payments/authorizations/{id}/void` |
| Find a dispute | `GET /v1/customer/disputes?disputed_transaction_id={capture}` |
| Answer it | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart, requested evidence type, evidence pack attached), or `.../send-message` at the inquiry stage |

## AI usage

Google Gemini (free tier; agent on `gemini-3.5-flash`, short tasks on `gemini-3.1-flash-lite`, with automatic failover across models):
- **Mandate extraction** with a JSON response schema (`src/ai.js`)
- **Shopping agent** with function calling: search, read listing, add to cart, checkout (`src/agent.js`)
- **Plain-English explanations** of each decision (`src/ai.js`)
- **Shelf import:** messy product lists into clean catalog entries (`src/ai.js`)

- **Dispute replies** drafted from the signed evidence pack only (`src/ai.js`)

Model output is always validated, and the payment decision itself is deterministic (`src/sentinel.js`). If Gemini is unreachable, the mandate falls back to an offline parser and the agent to the scripted one, so the demo never stalls.

## Run it

Requires Node.js 20+.

```bash
npm install
cp .env.example .env    # add PayPal sandbox + Gemini keys (optional)
npm run build           # build the web UI (once)
npm start               # http://localhost:3000
npm test                # rule engine tests
```

Without keys, PayPal and/or AI run in **mock mode**, so the full flow can be clicked through with zero setup.

The web UI lives in `web/` (React 19, Vite, Tailwind CSS v4, Motion). `npm run build` builds it into `web/dist`, which the server serves; without a build the server falls back to the plain UI in `public/`. For UI work, run `npm start` and `npm run dev:web` (Vite on :5173, proxying `/api` to :3000).

| Variable | Where |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → Sandbox |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |

| `PAYPAL_CARD_DEMO=1` | Shows the one-click sandbox test-card button |
| `RECEIPT_SECRET` | Any long random string; signs evidence receipts |

**Sandbox accounts.** Use a **US** sandbox *Business* account for the app (Developer Dashboard → Sandbox accounts → Create account → Business → United States, then create the app under Apps & Credentials with that account). Accounts from some countries, such as India, cannot take card payments or same-country PayPal payments in sandbox. To approve with PayPal, log in with a **Personal** sandbox account.

### Deploy (Render)

`render.yaml` is a Render Blueprint: New → Blueprint → pick this repo, then fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `GEMINI_API_KEY`.

## Try the attack

1. Shopper tab → "Buy one pack of AA batteries under $15" → **Create mandate**
2. Tick **Attack mode** → **Let the agent shop**. The agent visits BargainBin, whose listing hides an instruction to add a "protection plan", and whose checkout price is higher than its listing.
3. Approve in PayPal → PaySentinel **voids** the hold and shows exactly why.
4. Untick attack mode and repeat → the honest purchase is **captured**.

## Try Guardian mode

1. Shopper tab → **Shopping for: Mom** → pick *"A caller from my bank says I must buy gift cards…"* → run the flow. The request itself is satisfied, but the guardian's rule blocks it and the money is released.
2. Pick *"Buy 5 bags of basmati rice under $70"* → over the per-order limit → **Guardian** tab → Approve and pay.

## Project structure

```
src/server.js     API routes and the hold → check → capture/void flow
src/sentinel.js   the deterministic rule engine
src/agent.js      Gemini shopping agent + scripted vulnerable agent
src/ai.js         Gemini calls (with model failover): mandate, explanations, dispute drafts, Shelf import
src/catalog.js    shop catalogs, search, listing scanner
src/profiles.js   Guardian mode profiles and rules
src/evidence.js   signed receipts and dispute evidence packs
src/mcp.js        MCP server: lets any AI agent pay through PaySentinel
src/paypal.js     PayPal OAuth, Orders v2, authorize/capture/void
web/              React UI (Vite + Tailwind v4 + Motion, Magic UI components)
public/           fallback plain UI (used if web/ is not built)
test/             rule engine tests
```

## Research behind it

- [WebDecept (arXiv 2606.13686)](https://arxiv.org/html/2606.13686v1): web agents fall for deceptive e-commerce interfaces
- [Whispers of Wealth (arXiv 2601.22569)](https://arxiv.org/html/2601.22569): prompt injection against agent payments
- [Beyond the Mandate (arXiv 2608.23858)](https://arxiv.org/abs/2608.23858v1): signed mandates don't guarantee intent
- [Decision-Centered Architecture for Trustworthy Agentic Commerce (arXiv 2607.18347)](https://arxiv.org/pdf/2607.18347): check authority against live state at payment time

## License

MIT. Animated UI components in `web/src/components/ui/` come from [Magic UI](https://magicui.design) (MIT).
