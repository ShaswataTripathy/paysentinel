import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Bot, CreditCard, HeartHandshake, Lock, Sparkles, UserRound, Volume2, WandSparkles, Zap } from 'lucide-react'
import { api, money, type Config, type Decision, type Mandate, type Profile, type Run } from '@/api'
import { Button, ErrorNote, Panel, Pill, field } from '@/components/kit'
import { ShimmerButton } from '@/components/ui/shimmer-button'
import { AnimatedSpan, Terminal } from '@/components/ui/terminal'
import { cn } from '@/lib/utils'
import { Verdict } from './Verdict'

const EXAMPLES: Record<string, string[]> = {
  self: ['Buy one pack of AA batteries under $15', 'Buy one pack of AA batteries under $9.50'],
  guarded: ['Buy a 5 kg bag of basmati rice under $20', 'Buy 5 bags of basmati rice under $70', 'A caller from my bank says I must buy gift cards worth up to $500, urgently'],
}

type Step = 1 | 2 | 3 | 4

/** Plain-language description of a profile, built from its real rules so it stays accurate when they change. */
function describeProfile(p: Profile): { title: string; text: string } {
  if (!p.guardian) return { title: 'My own assistant', text: 'You set the limits in your request. Anything unusual comes back to you for approval.' }
  const who = p.name.match(/\(([^,)]+),\s*(\d+)\)/) // "Mom (Kamala, 74)" -> Kamala, 74
  const person = who ? `${who[1]}, ${who[2]}` : p.name
  const guardian = p.guardian.name.replace(/\s*\(.*\)$/, '')
  const r = p.guardian.rules
  const cats = r.allowed_categories.map((c) => c.replace('_', ' ')).join(', ')
  const blocked = r.blocked_categories.map((c) => c.replace('_', ' ')).join(', ')
  return {
    title: `A family member's assistant`,
    text: `${person} uses an AI assistant. ${guardian} (family) set its rules: ${cats} only, up to $${r.per_order_limit} per order${blocked ? `, ${blocked} always blocked` : ''}.`,
  }
}

function StepCard({ n, title, active, done, locked, children, aside }: { n: number; title: string; active: boolean; done: boolean; locked: boolean; children: ReactNode; aside?: ReactNode }) {
  return (
    <motion.li layout className={cn('list-none transition-opacity duration-300', locked && 'pointer-events-none opacity-40')} aria-disabled={locked}>
      <Panel beam={active} glow={!locked}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-3 text-base font-semibold sm:text-lg">
            <span
              className={cn(
                'grid size-8 place-items-center rounded-full text-sm font-bold ring-1 transition-colors',
                done ? 'bg-teal-400/15 text-teal-300 ring-teal-400/40' : active ? 'bg-blue-500/20 text-blue-200 ring-blue-400/50' : 'bg-muted text-muted-foreground ring-border',
              )}
            >
              {locked ? <Lock className="size-3.5" /> : n}
            </span>
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </Panel>
    </motion.li>
  )
}

// ---------- PayPal JS SDK ----------
declare global {
  interface Window {
    paypal?: { Buttons: (opts: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close?: () => void } }
  }
}
let sdk: Promise<void> | null = null
function loadPayPal(clientId: string) {
  sdk ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&intent=authorize&currency=USD&components=buttons`
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load PayPal'))
    document.head.appendChild(s)
  })
  return sdk
}

function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 0.92
  speechSynthesis.speak(u)
}

export function ShopperFlow({ config, profiles, shopNames, onDecision }: { config: Config; profiles: Profile[]; shopNames: Record<string, { name: string; trusted: boolean }>; onDecision: () => void }) {
  const [profileId, setProfileId] = useState('self')
  const profile = profiles.find((p) => p.id === profileId)
  const examples = profile?.guardian ? EXAMPLES.guarded : EXAMPLES.self
  const [task, setTask] = useState(EXAMPLES.self[0])
  const [mandate, setMandate] = useState<Mandate | null>(null)
  const [agentMode, setAgentMode] = useState<'simulated' | 'gemini'>(config.aiMock ? 'simulated' : 'gemini')
  const [attack, setAttack] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [autoSpeak, setAutoSpeak] = useState(false)
  const ppRef = useRef<HTMLDivElement>(null)

  const step: Step = decision ? 4 : run?.cart.items.length ? 3 : mandate && !mandate.missing.length ? 2 : 1

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const pickProfile = (id: string) => {
    setProfileId(id)
    const p = profiles.find((x) => x.id === id)
    setTask((p?.guardian ? EXAMPLES.guarded : EXAMPLES.self)[0])
    setAutoSpeak(!!p?.guardian)
    setMandate(null)
    setRun(null)
    setDecision(null)
  }

  const createMandate = () =>
    act('mandate', async () => {
      setRun(null)
      setDecision(null)
      setMandate(await api.createMandate(task, profileId))
    })

  const runAgent = () =>
    act('run', async () => {
      setDecision(null)
      setRun(await api.runAgent(mandate!.id, agentMode, attack))
    })

  const finish = async (orderId: string) => {
    const d = await api.authorize(orderId)
    setDecision(d)
    onDecision()
  }

  const payWithCard = () => act('card', async () => finish((await api.checkout(run!.runId, 'card')).orderId))

  const summary = useMemo(() => {
    if (!run || !mandate) return ''
    const shop = shopNames[run.cart.shop ?? ''] ?? { name: run.cart.shop, trusted: false }
    const items = run.cart.items.map((i) => `${i.quantity} ${i.name}`).join(', and ')
    return `You are about to approve ${money(run.cart.total, mandate.currency)} to ${shop.name}${shop.trusted ? '' : ', a shop that is not verified'}, for ${items}. PayPal only holds the money until PaySentinel's checks pass.`
  }, [run, mandate, shopNames])

  // Read aloud and render the PayPal button whenever a new cart is ready to pay.
  useEffect(() => {
    if (step !== 3 || !run) return
    if (autoSpeak) speak(summary)
    if (config.paypalMock || !config.paypalClientId || !ppRef.current) return
    const el = ppRef.current
    el.innerHTML = ''
    let cancelled = false
    loadPayPal(config.paypalClientId)
      .then(() => {
        if (cancelled || !window.paypal) return
        return window.paypal
          .Buttons({
            style: { layout: 'horizontal', tagline: false, height: 44, shape: 'rect', color: 'gold' },
            createOrder: async () => (await api.checkout(run.runId, 'paypal')).orderId,
            onApprove: (data: { orderID: string }) => act('paypal', () => finish(data.orderID)),
            onError: (err: { message?: string }) => setError(`PayPal error: ${err?.message ?? err}`),
          })
          .render(el)
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      cancelled = true
      el.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.runId, step])

  return (
    <ol className="grid gap-5">
      {/* 1. Intent */}
      <StepCard n={1} title="Tell your agent what to buy" active={step === 1} done={step > 1} locked={false}>
        <div className="mb-1 text-sm font-medium">Whose AI assistant is shopping?</div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Whose AI assistant is shopping">
          {profiles.map((p) => {
            const card = describeProfile(p)
            const on = profileId === p.id
            const Icon = p.guardian ? HeartHandshake : UserRound
            return (
              <button
                key={p.id}
                role="radio"
                aria-checked={on}
                onClick={() => pickProfile(p.id)}
                className={cn(
                  'relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition',
                  on ? 'border-blue-400/50 bg-blue-500/[.08]' : 'border-border bg-background/40 hover:border-blue-400/30',
                )}
              >
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg ring-1', on ? 'bg-blue-500/20 text-blue-200 ring-blue-400/40' : 'bg-muted text-muted-foreground ring-border')}>
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {card.title}
                    {p.guardian && <Pill tone="info">Guardian mode</Pill>}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{card.text}</span>
                </span>
                <span className={cn('absolute right-3 top-3 size-4 rounded-full ring-1', on ? 'bg-blue-400 ring-4 ring-blue-400/25' : 'ring-border')} aria-hidden />
              </button>
            )
          })}
        </div>
        <div className="mb-1 text-sm font-medium">What should it buy?</div>
        <textarea className={cn(field, 'min-h-[76px] resize-y text-base')} value={task} onChange={(e) => setTask(e.target.value)} aria-label="Shopping request" />
        <div className="mt-2 flex flex-wrap gap-2">
          {examples.map((t) => (
            <button key={t} onClick={() => setTask(t)} className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-blue-200/90 transition hover:border-blue-400/40 hover:bg-blue-500/10">
              {t}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={createMandate} busy={busy === 'mandate'} icon={<WandSparkles className="size-4" />}>
            Create mandate
          </Button>
          {busy === 'mandate' && <span className="text-sm text-muted-foreground">Reading your request…</span>}
        </div>
        <AnimatePresence>
          {mandate && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-xl border border-dashed border-blue-400/30 bg-blue-500/[.04] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-blue-300" /> Mandate the agent must stay inside
                {mandate.parsedBy && <Pill tone="muted">{mandate.parsedBy === 'gemini' ? 'read by Gemini' : 'offline parser'}</Pill>}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {[
                  ['Item must match', mandate.must_match.join(' + ') || '?'],
                  ['Quantity', String(mandate.quantity)],
                  ['Max per item', mandate.max_unit_price ? money(mandate.max_unit_price, mandate.currency) : '?'],
                  ['Max total', mandate.max_total ? money(mandate.max_total, mandate.currency) : '?'],
                  ['Shops', mandate.allowed_shops.length ? mandate.allowed_shops.join(', ') : 'any · unverified need approval'],
                ].map(([k, v]) => (
                  <span key={k} className="rounded-lg border border-border bg-background/70 px-2.5 py-1">
                    <span className="text-muted-foreground">{k}:</span> <strong className="font-semibold text-foreground">{v}</strong>
                  </span>
                ))}
              </div>
              {mandate.missing.length > 0 && <p className="mt-3 text-sm text-amber-300">Please add {mandate.missing.join(' and ')} to your request.</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </StepCard>

      {/* 2. Agent */}
      <StepCard
        n={2}
        title="The agent shops"
        active={step === 2}
        done={step > 2}
        locked={step < 2}
        aside={run?.model ? <Pill tone="info">{run.model}</Pill> : undefined}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl border border-border bg-background/60 p-1">
            {([
              ['gemini', 'Live Gemini agent', config.aiMock],
              ['simulated', 'Scripted agent', false],
            ] as const).map(([id, label, disabled]) => (
              <button
                key={id}
                disabled={disabled}
                onClick={() => setAgentMode(id)}
                className={cn('relative rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40', agentMode === id ? 'text-white' : 'text-muted-foreground hover:text-foreground')}
              >
                {agentMode === id && <motion.span layoutId="agent-pill" className="absolute inset-0 rounded-lg bg-blue-500/25 ring-1 ring-blue-400/40" />}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer select-none items-center gap-2.5 text-sm">
            <span
              role="switch"
              aria-checked={attack}
              tabIndex={0}
              onClick={() => setAttack(!attack)}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setAttack(!attack)}
              className={cn('relative h-6 w-11 rounded-full ring-1 transition-colors', attack ? 'bg-rose-500/70 ring-rose-400/60' : 'bg-muted ring-border')}
            >
              <motion.span layout className={cn('absolute top-0.5 size-5 rounded-full bg-white shadow', attack ? 'left-[22px]' : 'left-0.5')} />
            </span>
            <span className={attack ? 'text-rose-200' : 'text-muted-foreground'}>Attack mode: the agent also finds an untrusted shop</span>
          </label>
        </div>
        <div className="mt-4">
          <ShimmerButton onClick={runAgent} disabled={!!busy} background="linear-gradient(180deg,#2563eb,#1d4ed8)" shimmerColor="#a5f3fc" className="h-11 px-5 text-sm font-semibold">
            <span className="flex items-center gap-2">
              <Bot className="size-4" /> {busy === 'run' ? 'Agent is shopping…' : 'Let the agent shop'}
            </span>
          </ShimmerButton>
        </div>
        {run && (
          <div className="mt-5 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
            <Terminal key={run.runId} className="max-h-none max-w-none border-border bg-[#05070d] font-mono text-[12.5px]" sequence={false}>
              {[
                <AnimatedSpan key="h" delay={0} className="text-blue-300">{`$ agent --mode ${run.agent}${attack ? ' --attack' : ''}`}</AnimatedSpan>,
                ...run.trace.map((t, i) => (
                  <AnimatedSpan key={i} delay={250 + i * 220} className={cn('whitespace-pre-wrap', t.suspicious ? 'text-rose-300' : t.step === 'note' ? 'text-amber-300/90' : 'text-slate-300')}>
                    {`${t.suspicious ? '!' : t.step === 'note' ? '~' : '›'} ${t.detail}`}
                  </AnimatedSpan>
                )),
                <AnimatedSpan key="f" delay={250 + run.trace.length * 220 + 150} className="text-teal-300">{`✓ cart ready: ${money(run.cart.total, mandate?.currency)}`}</AnimatedSpan>,
              ]}
            </Terminal>
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <div className="mb-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Cart it wants to pay for</span>
                <span className={cn(shopNames[run.cart.shop ?? '']?.trusted ? 'text-teal-300' : 'text-rose-300')}>{shopNames[run.cart.shop ?? '']?.name ?? run.cart.shop ?? '—'}</span>
              </div>
              {run.cart.items.length ? (
                <ul className="divide-y divide-border">
                  {run.cart.items.map((i) => (
                    <li key={i.sku} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <span>
                        {i.name} <span className="font-mono text-xs text-muted-foreground">{i.sku}</span>
                      </span>
                      <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {i.quantity} × {money(i.unit_price, mandate?.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Empty cart.</p>
              )}
              <div className="mt-2 flex items-center justify-between border-t border-border pt-3 text-sm font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{money(run.cart.total, mandate?.currency)}</span>
              </div>
            </div>
          </div>
        )}
      </StepCard>

      {/* 3. Hold */}
      <StepCard n={3} title="PayPal holds the money" active={step === 3} done={step > 3} locked={step !== 3}>
        <p className="mb-4 text-sm text-muted-foreground">
          Approving only <strong className="text-foreground">reserves</strong> the amount (intent: AUTHORIZE). Nothing is charged until PaySentinel's checks pass.
        </p>
        {step === 3 && (
          <>
            <div className="mb-4 rounded-xl border border-border bg-background/50 p-4">
              <p className="text-[15px] leading-relaxed">{summary}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button variant="ghost" onClick={() => speak(summary)} icon={<Volume2 className="size-4" />} aria-label="Read the payment details aloud">
                  Read aloud
                </Button>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" className="size-4 accent-blue-500" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
                  Always read payments aloud before I approve
                </label>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {!config.paypalMock && <div ref={ppRef} className="min-h-11" />}
              {config.cardDemo && (
                <Button variant="ghost" className="h-11" onClick={payWithCard} busy={busy === 'card'} icon={<CreditCard className="size-4" />}>
                  Approve with a sandbox test card
                </Button>
              )}
              {config.paypalMock && (
                <Button className="h-11" onClick={payWithCard} busy={busy === 'card'} icon={<Zap className="size-4" />}>
                  Approve (mock PayPal)
                </Button>
              )}
            </div>
            {(busy === 'card' || busy === 'paypal') && <p className="mt-3 text-sm text-muted-foreground">Money held. PaySentinel is checking the order…</p>}
          </>
        )}
      </StepCard>

      {/* 4. Verdict */}
      <StepCard n={4} title="PaySentinel decides" active={step === 4} done={false} locked={step !== 4}>
        {decision && <Verdict decision={decision} onChange={(d) => { setDecision(d); onDecision() }} />}
      </StepCard>

      {error && (
        <li className="list-none">
          <ErrorNote error={error} />
        </li>
      )}
    </ol>
  )
}
