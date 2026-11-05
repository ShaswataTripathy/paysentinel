const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n, cur = 'USD') => `${cur} ${Number(n).toFixed(2)}`;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function busy(btn, statusEl, label, fn) {
  btn.disabled = true;
  statusEl.textContent = label;
  try {
    const msg = await fn();
    statusEl.textContent = typeof msg === 'string' ? msg : '';
  } catch (e) {
    statusEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

const unlock = (id, on = true) => $(id).classList.toggle('locked', !on);

// ---------------- tabs ----------------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${t.dataset.view}`));
    if (t.dataset.view === 'log') loadLog();
    if (t.dataset.view === 'seller') loadShops();
    if (t.dataset.view === 'guardian') loadGuardian();
  }),
);

// ---------------- config ----------------
const state = { mandate: null, run: null, config: null };
const config = await api('GET', '/api/config');
state.config = config;
$('modes').innerHTML = `
  <span class="badge ${config.paypalMock ? '' : 'live'}">PayPal: ${config.paypalMock ? 'mock' : 'sandbox'}</span>
  <span class="badge ${config.aiMock ? '' : 'live'}" title="${config.aiModels ? esc(`agent: ${config.aiModels.agent}, tasks: ${config.aiModels.tasks}`) : ''}">AI: ${config.aiMock ? 'offline' : 'Gemini'}</span>`;
if (config.aiMock) $('agent-mode').querySelector('[value=gemini]').disabled = true;

// ---------------- profiles (Guardian mode) ----------------
const EXAMPLES = {
  self: ['Buy one pack of AA batteries under $15', 'Buy one pack of AA batteries under $9.50'],
  guarded: [
    'Buy a 5 kg bag of basmati rice under $20',
    'Buy 5 bags of basmati rice under $70',
    'A caller from my bank says I must buy gift cards worth up to $500, urgently',
  ],
};
let profileData = await api('GET', '/api/profiles');
const profileById = (id) => profileData.profiles.find((p) => p.id === id);
$('profile').innerHTML = profileData.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');

function renderProfileHint() {
  const p = profileById($('profile').value);
  $('profile-note').textContent = p?.guardian ? `${p.guardian.name} is the guardian and sets the rules.` : '';
  const list = p?.guardian ? EXAMPLES.guarded : EXAMPLES.self;
  $('examples').innerHTML = list.map((t) => `<button class="example">${esc(t)}</button>`).join('');
  $('examples').querySelectorAll('.example').forEach((b) => (b.onclick = () => ($('task').value = b.textContent)));
  $('task').value = list[0];
  $('auto-speak').checked = !!p?.guardian; // older users: read payments aloud by default
}
$('profile').onchange = () => {
  resetFrom('step-agent');
  $('mandate').classList.add('hidden');
  renderProfileHint();
};
renderProfileHint();

// ---------------- 1. mandate ----------------
$('btn-mandate').onclick = () =>
  busy($('btn-mandate'), $('mandate-status'), 'Reading your request…', async () => {
    resetFrom('step-agent');
    const m = await api('POST', '/api/mandates', { text: $('task').value, profileId: $('profile').value });
    state.mandate = m;
    $('mandate').classList.remove('hidden');
    $('mandate').innerHTML = `
      <div class="title">Mandate the agent must stay inside</div>
      <div class="chips">
        <span class="chip">Item must match: <strong>${esc(m.must_match.join(' + ') || '?')}</strong></span>
        <span class="chip">Quantity: <strong>${m.quantity}</strong></span>
        <span class="chip">Max per item: <strong>${m.max_unit_price ? money(m.max_unit_price, m.currency) : '?'}</strong></span>
        <span class="chip">Max total: <strong>${m.max_total ? money(m.max_total, m.currency) : '?'}</strong></span>
        <span class="chip">Shops: <strong>${m.allowed_shops.length ? esc(m.allowed_shops.join(', ')) : 'any, unverified need approval'}</strong></span>
      </div>
      ${m.missing.length ? `<p class="flag">Please add ${esc(m.missing.join(' and '))} to your request.</p>` : ''}`;
    unlock('step-agent', !m.missing.length);
  });

// ---------------- 2. agent ----------------
$('btn-run').onclick = () =>
  busy($('btn-run'), $('run-status'), 'Agent is shopping…', async () => {
    resetFrom('step-pay');
    const run = await api('POST', `/api/mandates/${state.mandate.id}/run`, { agent: $('agent-mode').value, attack: $('attack').checked });
    state.run = run;
    $('run').classList.remove('hidden');
    $('trace').innerHTML = run.trace.map((t) => `<li class="${t.suspicious ? 'sus' : ''}" title="${esc(t.tool ?? '')}">${esc(t.detail)}</li>`).join('');
    const c = run.cart;
    $('cart').tBodies[0].innerHTML = c.items.length
      ? c.items.map((i) => `<tr><td>${esc(i.name)} <span class="muted">${esc(i.sku)}</span></td><td>${i.quantity}</td><td>${money(i.unit_price, state.mandate.currency)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">Empty cart.</td></tr>';
    $('cart').tFoot.innerHTML = `<tr><td colspan="2">Total at ${esc(c.shop ?? '-')}</td><td>${money(c.total, state.mandate.currency)}</td></tr>`;
    if (c.items.length) preparePayment();
  });

// ---------------- 3. PayPal hold ----------------
let paypalLoaded = null;
function loadPayPal() {
  paypalLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&intent=authorize&currency=USD&components=buttons`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load PayPal'));
    document.head.appendChild(s);
  });
  return paypalLoaded;
}

async function startCheckout(method = 'paypal') {
  const { orderId } = await api('POST', '/api/checkout', { runId: state.run.runId, method });
  return orderId;
}

async function finishCheckout(orderId) {
  $('pay-status').textContent = 'Money held. PaySentinel is checking the order…';
  const d = await api('POST', `/api/orders/${encodeURIComponent(orderId)}/authorize`);
  $('pay-status').textContent = '';
  showVerdict(d);
}

// ---------------- read aloud (accessibility) ----------------
const shopNames = Object.fromEntries((await api('GET', '/api/shops')).map((s) => [s.id, { name: s.name, trusted: s.trusted }]));
const spoken = (n, cur) => `${Number(n).toFixed(2)} ${cur === 'USD' ? 'US dollars' : cur}`;

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9; // a little slower, easier to follow
  speechSynthesis.speak(u);
}

function paySummary() {
  const c = state.run.cart;
  const shop = shopNames[c.shop] ?? { name: c.shop, trusted: false };
  const items = c.items.map((i) => `${i.quantity} ${i.name}`).join(', and ');
  return `You are about to approve a payment of ${spoken(c.total, state.mandate.currency)} to ${shop.name}${shop.trusted ? '' : ', a shop that is not verified'}, for ${items}. PayPal will only hold the money until PaySentinel's checks pass.`;
}
$('btn-speak').onclick = () => speak($('pay-summary').textContent);

async function preparePayment() {
  unlock('step-pay');
  $('pay-summary').textContent = paySummary();
  if ($('auto-speak').checked) speak($('pay-summary').textContent);
  $('paypal-buttons').innerHTML = '';
  if (state.config.paypalMock) {
    $('btn-mock-pay').classList.remove('hidden');
    return;
  }
  $('btn-mock-pay').classList.add('hidden');
  $('btn-card-pay').classList.toggle('hidden', !state.config.cardDemo);
  try {
    await loadPayPal();
    window.paypal
      .Buttons({
        style: { layout: 'horizontal', tagline: false, height: 42 },
        createOrder: () => startCheckout('paypal'),
        onApprove: (data) => finishCheckout(data.orderID).catch((e) => ($('pay-status').textContent = e.message)),
        onError: (err) => ($('pay-status').textContent = `PayPal error: ${err?.message ?? err}`),
      })
      .render('#paypal-buttons');
  } catch (e) {
    $('pay-status').textContent = e.message;
  }
}

$('btn-card-pay').onclick = () =>
  busy($('btn-card-pay'), $('pay-status'), 'PayPal is placing the hold on the test card…', async () => {
    await finishCheckout(await startCheckout('card'));
  });

$('btn-mock-pay').onclick = () =>
  busy($('btn-mock-pay'), $('pay-status'), 'Holding money…', async () => {
    await finishCheckout(await startCheckout());
  });

// ---------------- 4. verdict ----------------
const HEAD = {
  capture: ['Payment captured', 'Every check passed, so PayPal charged the held amount.'],
  void: ['Payment blocked', 'PayPal released the held money. Nothing was charged.'],
  review: ['Needs your approval', 'The money is still held. You decide.'],
};
const ICON = { pass: '✓', review: '!', block: '✕' };

function showVerdict(d) {
  unlock('step-verdict');
  unlock('step-pay', false); // this cart is paid or blocked; a new run is needed for another payment
  $('btn-mock-pay').classList.add('hidden');
  $('btn-card-pay').classList.add('hidden');
  $('paypal-buttons').innerHTML = '';
  const key = d.decision === 'review' && d.resolvedBy ? (d.payment.action === 'captured' ? 'capture' : 'void') : d.decision;
  let [title, sub] = HEAD[key];
  const toGuardian = d.approver && d.approver !== 'you';
  if (key === 'review' && toGuardian) title = `Sent to ${d.approver} for approval`;
  if (d.resolvedBy === 'guardian') title += ` by ${d.approver}`;
  const guardianAlert = toGuardian && key === 'void' && d.checks.some((c) => c.id.startsWith('g_') && c.status === 'block');
  $('verdict').innerHTML = `
    <div class="verdict ${key}">
      <div class="big">${title}</div>
      <p>${esc(d.explanation || sub)}</p>
      ${guardianAlert ? `<p><strong>${esc(d.approver)} has been alerted.</strong></p>` : ''}
      ${key === 'review' && toGuardian ? `<p>The money stays on hold until ${esc(d.approver)} decides in the Guardian tab.</p>` : ''}
    </div>
    ${d.decision === 'review' && !d.resolvedBy && !toGuardian ? `<div class="row"><button class="good" id="btn-approve">Approve and pay</button><button class="bad" id="btn-reject">Reject</button><span class="muted" id="review-status"></span></div>` : ''}
    <h3>Checks</h3>
    <ul class="checks">${d.checks.map((c) => `<li class="${c.status}"><span class="ico">${ICON[c.status]}</span><span><span class="lbl">${esc(c.label)}</span> · ${esc(c.detail)}</span></li>`).join('')}</ul>
    <div class="ids">PayPal order ${esc(d.order.id)} · authorization ${esc(d.order.authorizationId)} · ${esc(d.payment.action ?? 'held')}${d.payment.id ? ` · capture ${esc(d.payment.id)}` : ''}</div>`;
  const resolve = (action) => () =>
    busy($(`btn-${action}`), $('review-status'), action === 'approve' ? 'Capturing…' : 'Releasing…', async () => {
      showVerdict(await api('POST', `/api/decisions/${d.id}/${action}`));
    });
  $('btn-approve')?.addEventListener('click', resolve('approve'));
  $('btn-reject')?.addEventListener('click', resolve('reject'));
  $('step-verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
  refreshGuardianCount();
}

// ---------------- Guardian view ----------------
async function refreshGuardianCount() {
  const rows = await api('GET', '/api/decisions');
  const n = rows.filter((d) => d.decision === 'review' && !d.resolvedBy && d.approver !== 'you').length;
  $('guardian-count').textContent = n;
  $('guardian-count').classList.toggle('hidden', !n);
  return rows;
}

const itemsText = (d) => d.order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ');

async function loadGuardian() {
  const rows = (await refreshGuardianCount()).filter((d) => d.approver && d.approver !== 'you');
  const pending = rows.filter((d) => d.decision === 'review' && !d.resolvedBy);
  const blocked = rows.filter((d) => d.payment.action === 'voided' && d.resolvedBy === 'sentinel');

  $('g-pending').innerHTML = pending.length
    ? pending
        .map(
          (d) => `<div class="request">
            <div><strong>${esc(d.profileName)}</strong>'s assistant wants to pay <strong>${money(d.order.total, d.order.currency)}</strong> at ${esc(d.order.shop)}</div>
            <div class="muted">"${esc(d.request)}" · ${esc(itemsText(d))}</div>
            <ul class="checks compact">${d.checks.filter((c) => c.status !== 'pass').map((c) => `<li class="${c.status}"><span class="ico">${ICON[c.status]}</span><span>${esc(c.detail)}</span></li>`).join('')}</ul>
            <div class="row"><button class="good" data-id="${d.id}" data-act="approve">Approve and pay</button><button class="bad" data-id="${d.id}" data-act="reject">Reject</button><span class="muted" id="gs-${d.id}"></span></div>
          </div>`,
        )
        .join('')
    : '<p class="muted">Nothing waiting.</p>';
  $('g-pending').querySelectorAll('button[data-act]').forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, $(`gs-${b.dataset.id}`), b.dataset.act === 'approve' ? 'Capturing…' : 'Releasing…', async () => {
          await api('POST', `/api/decisions/${b.dataset.id}/${b.dataset.act}`);
          loadGuardian();
        })),
  );

  $('g-blocked').innerHTML = blocked.length
    ? blocked
        .map(
          (d) => `<div class="request blocked">
            <div><strong>Blocked:</strong> ${esc(d.profileName)}'s assistant tried to pay ${money(d.order.total, d.order.currency)} for ${esc(itemsText(d))}</div>
            <div class="muted">"${esc(d.request)}" · ${new Date(d.at).toLocaleString()}</div>
            <div>${esc(d.explanation)}</div>
          </div>`,
        )
        .join('')
    : '<p class="muted">Nothing blocked yet.</p>';

  renderRules();
}

function renderRules() {
  const guarded = profileData.profiles.filter((p) => p.guardian);
  const cats = profileData.categories;
  const label = (c) => c.replace('_', ' ');
  $('g-rules').innerHTML = guarded
    .map((p) => {
      const r = p.guardian.rules;
      const box = (kind, c) => `<label class="check"><input type="checkbox" data-kind="${kind}" value="${c}" ${r[kind].includes(c) ? 'checked' : ''}> ${label(c)}</label>`;
      return `<form data-profile="${esc(p.id)}">
        <h2>Rules for ${esc(p.name)}</h2>
        <p class="muted">Set by ${esc(p.guardian.name)}. PaySentinel enforces these on every payment, even if ${esc(p.name.split(' ')[0])} asks the assistant for something else.</p>
        <div class="rule-grid">
          <fieldset><legend>Allowed without asking</legend>${cats.map((c) => box('allowed_categories', c)).join('')}</fieldset>
          <fieldset><legend>Always blocked</legend>${cats.map((c) => box('blocked_categories', c)).join('')}</fieldset>
          <fieldset><legend>Limits (USD)</legend>
            <label>Per order, above this I approve <input type="number" min="0" step="1" name="per_order_limit" value="${r.per_order_limit}"></label>
            <label>Weekly budget <input type="number" min="0" step="1" name="weekly_limit" value="${r.weekly_limit}"></label>
            <label class="check"><input type="checkbox" name="verified_shops_only" ${r.verified_shops_only ? 'checked' : ''}> Verified shops only</label>
          </fieldset>
        </div>
        <div class="row"><button type="submit">Save rules</button><span class="muted" data-status></span></div>
      </form>`;
    })
    .join('');
  $('g-rules').querySelectorAll('form').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const pick = (kind) => [...f.querySelectorAll(`input[data-kind=${kind}]:checked`)].map((i) => i.value);
      busy(f.querySelector('button'), f.querySelector('[data-status]'), 'Saving…', async () => {
        const updated = await api('PUT', `/api/profiles/${f.dataset.profile}/rules`, {
          allowed_categories: pick('allowed_categories'),
          blocked_categories: pick('blocked_categories'),
          per_order_limit: f.per_order_limit.value,
          weekly_limit: f.weekly_limit.value,
          verified_shops_only: f.verified_shops_only.checked,
        });
        profileData.profiles = profileData.profiles.map((p) => (p.id === updated.id ? updated : p));
        return 'Saved. New payments use these rules.';
      });
    };
  });
}
refreshGuardianCount();

function resetFrom(stepId) {
  const order = ['step-agent', 'step-pay', 'step-verdict'];
  for (const id of order.slice(order.indexOf(stepId))) unlock(id, false);
  if (stepId === 'step-agent') $('run').classList.add('hidden');
  $('paypal-buttons').innerHTML = '';
  $('btn-mock-pay').classList.add('hidden');
  $('btn-card-pay').classList.add('hidden');
  $('verdict').innerHTML = '';
}

// ---------------- seller / Shelf ----------------
$('btn-import').onclick = () =>
  busy($('btn-import'), $('import-status'), 'Building your shop…', async () => {
    const shop = await api('POST', '/api/shelf/import', { name: $('shop-name').value, products: $('shop-products').value });
    $('import-status').textContent = `${shop.products.length} products listed.`;
    loadShops();
  });

async function loadShops() {
  const shops = await api('GET', '/api/shops');
  const full = await Promise.all(shops.map((s) => api('GET', `/api/shops/${s.id}`)));
  $('shops').innerHTML = full
    .map(
      (s) => `<div class="shop">
        <div class="row space"><strong>${esc(s.name)}</strong><span class="badge ${s.trusted ? 'live' : ''}">${s.trusted ? 'verified' : 'unverified'}</span></div>
        <div class="table-wrap"><table><thead><tr><th>SKU</th><th>Product</th><th>Price</th><th>Agent safety scan</th></tr></thead><tbody>
        ${s.products
          .map(
            (p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${money(p.price)}</td>
            <td>${p.scan.flagged ? `<span class="flag">Hidden instructions: ${esc(p.scan.reasons.join(', '))}${p.scan.pushedSkus.length ? ` (pushes ${esc(p.scan.pushedSkus.join(', '))})` : ''}</span>` : '<span class="muted">clean</span>'}</td></tr>`,
          )
          .join('')}
        </tbody></table></div></div>`,
    )
    .join('');
}
$('btn-shops').onclick = loadShops;

// ---------------- log ----------------
async function loadLog() {
  const rows = await api('GET', '/api/decisions');
  $('log').tBodies[0].innerHTML = rows.length
    ? rows
        .map((d) => {
          const outcome = d.payment.action ?? 'held';
          const reason = d.checks.filter((c) => c.status !== 'pass').map((c) => c.label).join(', ') || 'all checks passed';
          return `<tr><td>${new Date(d.at).toLocaleString()}</td><td>${esc(d.request)}<div class="muted">for ${esc(d.profileName ?? 'Me')}</div></td><td>${esc(d.order.shop)}</td><td>${money(d.order.total, d.order.currency)}</td>
            <td><span class="pill ${esc(outcome)}">${esc(outcome)}</span>${d.resolvedBy === 'shopper' ? ' <span class="muted">by you</span>' : d.resolvedBy === 'guardian' ? ` <span class="muted">by ${esc(d.approver)}</span>` : ''}${d.dispute ? ' <span class="pill review">disputed</span>' : ''}</td><td>${esc(reason)}</td>
            <td><button class="link" data-evidence="${d.id}" aria-label="Evidence for ${esc(d.request)}">Evidence</button></td></tr>`;
        })
        .join('')
    : '<tr><td colspan="7" class="muted">No agent payments yet.</td></tr>';
  $('log').querySelectorAll('[data-evidence]').forEach((b) => (b.onclick = () => showEvidence(b.dataset.evidence)));
}

// ---------------- evidence & disputes ----------------
$('btn-evidence-close').onclick = () => $('evidence-card').classList.add('hidden');

async function showEvidence(id) {
  const p = await api('GET', `/api/decisions/${id}/evidence`);
  const d = (await api('GET', '/api/decisions')).find((x) => x.id === id);
  const dis = d.dispute;
  const captured = p.paypal.outcome === 'captured';
  $('evidence-card').classList.remove('hidden');
  $('evidence').innerHTML = `
    <p>${esc(p.summary)}</p>
    <dl class="ev-grid">
      <dt>Instruction</dt><dd>"${esc(p.request)}" (for ${esc(p.on_behalf_of)})</dd>
      <dt>PayPal</dt><dd>order ${esc(p.paypal.order_id)} · authorization ${esc(p.paypal.authorization_id)}${p.paypal.capture_id ? ` · capture ${esc(p.paypal.capture_id)}` : ''}</dd>
      <dt>Checks</dt><dd>${p.checks.filter((c) => c.status === 'pass').length} of ${p.checks.length} passed</dd>
      <dt>Receipt</dt><dd>${p.receipt ? `SHA-256 ${esc(p.receipt.sha256.slice(0, 24))}… · ${p.receipt_valid ? '<span class="ok">signature valid</span>' : '<span class="flag">signature INVALID</span>'}` : 'not final yet'}</dd>
    </dl>
    <details><summary>Full evidence pack (JSON)</summary><pre class="json">${esc(JSON.stringify(p, null, 2))}</pre></details>
    ${
      captured
        ? `<div class="dispute">
            ${
              dis
                ? `<div><strong>Dispute ${esc(dis.dispute_id)}</strong> · ${esc(dis.reason)}${dis.stage ? ` · ${esc(dis.stage.toLowerCase())}` : ''} · <span class="pill review">${esc(dis.status)}</span></div>
                   ${dis.buyer_message ? `<div class="muted">Buyer: "${esc(dis.buyer_message)}"</div>` : ''}
                   ${
                     dis.response
                       ? `<p><strong>Response sent to PayPal</strong>${dis.channel === 'send-message' ? ' in the case thread (inquiry stage)' : dis.channel === 'provide-evidence' ? ` as formal evidence${dis.evidence_type ? ` (${esc(dis.evidence_type.toLowerCase().replaceAll('_', ' '))})` : ''}` : ''}, with the signed evidence pack attached:</p><p class="muted">${esc(dis.response)}</p>`
                       : `<label>Response to PayPal <textarea id="dispute-notes" rows="6" placeholder="Draft with AI, then edit before sending"></textarea></label>
                          <div class="row"><button class="ghost" id="btn-draft">Draft response with AI</button><button id="btn-submit-evidence">Send response + evidence to PayPal</button><span class="muted" id="dispute-status" role="status"></span></div>`
                   }`
                : `<div><strong>Buyer disputes?</strong> <span class="muted">e.g. "my AI assistant bought this without my permission"</span></div>
                   <div class="row">${
                     state.config.paypalMock
                       ? '<button class="ghost" id="btn-sim-dispute">Simulate a buyer dispute</button>'
                       : '<button class="ghost" id="btn-find-dispute">Find PayPal dispute</button><span class="muted">Open it first as the sandbox buyer in the PayPal Resolution Center.</span>'
                   }<span class="muted" id="dispute-status" role="status"></span></div>`
            }
          </div>`
        : ''
    }`;
  const act = (btnId, label, fn) => $(btnId) && ($(btnId).onclick = () => busy($(btnId), $('dispute-status'), label, fn));
  act('btn-sim-dispute', 'Opening dispute…', async () => { await api('POST', `/api/decisions/${id}/dispute/simulate`); showEvidence(id); loadLog(); });
  act('btn-find-dispute', 'Looking up PayPal…', async () => { await api('POST', `/api/decisions/${id}/dispute/find`); showEvidence(id); loadLog(); });
  act('btn-draft', 'Drafting from the evidence…', async () => { $('dispute-notes').value = (await api('POST', `/api/decisions/${id}/dispute/draft`)).notes; });
  act('btn-submit-evidence', 'Sending to PayPal…', async () => {
    await api('POST', `/api/decisions/${id}/dispute/submit`, { notes: $('dispute-notes').value });
    showEvidence(id);
    loadLog();
  });
  $('evidence-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('btn-log').onclick = loadLog;
