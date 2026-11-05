import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FileSignature, Gavel, ShieldCheck, ShieldX, Timer, Wallet, X } from 'lucide-react'
import { api, assistantLabel, LIMITS, money, type Config, type Decision, type EvidencePack } from '@/api'
import { Button, ErrorNote, Panel, Pill, SectionTitle, field } from '@/components/kit'
import { NumberTicker } from '@/components/ui/number-ticker'
import { cn } from '@/lib/utils'

function Stat({ icon, label, value, prefix = '', decimals = 0, tone }: { icon: React.ReactNode; label: string; value: number; prefix?: string; decimals?: number; tone: string }) {
  return (
    <Panel className="p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className={cn('grid size-8 place-items-center rounded-lg ring-1', tone)}>{icon}</span>
      </div>
      <div className="mt-3 text-3xl font-extrabold tabular-nums tracking-tight">
        {prefix}
        {value > 0 ? <NumberTicker value={value} decimalPlaces={decimals} className="text-foreground" /> : (0).toFixed(decimals)}
      </div>
    </Panel>
  )
}

const ATTACK = new Set(['injection', 'price', 'intent', 'catalog', 'total'])

function Evidence({ id, config, onClose, onChange }: { id: string; config: Config; onClose: () => void; onChange: () => void }) {
  const [pack, setPack] = useState<EvidencePack | null>(null)
  const [d, setD] = useState<Decision | null>(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setPack(await api.evidence(id))
    setD((await api.decisions()).find((x) => x.id === id) ?? null)
  }
  useEffect(() => {
    load().catch((e) => setError(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await load()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  if (!pack || !d) return <Panel><p className="text-sm text-muted-foreground">Loading evidence…</p><ErrorNote error={error} /></Panel>
  const dis = d.dispute
  const captured = pack.paypal.outcome === 'captured'

  return (
    <Panel beam>
      <div className="mb-3 flex items-start justify-between gap-3">
        <SectionTitle eyebrow="Signed evidence" title="Evidence & disputes">{pack.summary}</SectionTitle>
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close evidence"><X className="size-4" /></button>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="text-muted-foreground">Instruction</dt><dd>"{pack.request}" <span className="text-muted-foreground">for {pack.on_behalf_of}</span></dd>
        <dt className="text-muted-foreground">PayPal</dt><dd className="break-all font-mono text-xs">order {pack.paypal.order_id} · auth {pack.paypal.authorization_id}{pack.paypal.capture_id ? ` · capture ${pack.paypal.capture_id}` : ''}</dd>
        <dt className="text-muted-foreground">Checks</dt><dd>{pack.checks.filter((c) => c.status === 'pass').length} of {pack.checks.length} passed</dd>
        <dt className="text-muted-foreground">Receipt</dt>
        <dd>{pack.receipt ? <span className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">SHA-256 {pack.receipt.sha256.slice(0, 24)}…</span>{pack.receipt_valid ? <Pill tone="captured"><FileSignature className="size-3" /> signature valid</Pill> : <Pill tone="voided">signature INVALID</Pill>}</span> : 'not final yet'}</dd>
      </dl>
      <details className="mt-4 rounded-xl border border-border bg-background/50">
        <summary className="cursor-pointer px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">Full evidence pack (JSON)</summary>
        <pre className="max-h-80 overflow-auto px-4 pb-4 font-mono text-[11.5px] text-slate-300">{JSON.stringify(pack, null, 2)}</pre>
      </details>

      {captured && (
        <div className="mt-5 rounded-xl border border-border bg-background/40 p-4">
          {dis ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Gavel className="size-4 text-amber-300" /> <strong>Dispute {dis.dispute_id}</strong>
                <Pill tone="muted">{dis.reason.toLowerCase().replaceAll('_', ' ')}</Pill>
                {dis.stage && <Pill tone="info">{dis.stage.toLowerCase()}</Pill>}
                <Pill tone="review">{dis.status.toLowerCase().replaceAll('_', ' ')}</Pill>
              </div>
              {dis.buyer_message && <p className="mt-2 text-sm text-muted-foreground">Buyer: "{dis.buyer_message}"</p>}
              {dis.response ? (
                <div className="mt-3 text-sm">
                  <p className="font-semibold text-teal-300">
                    Response sent to PayPal{dis.channel === 'send-message' ? ' in the case thread (inquiry stage)' : dis.channel === 'provide-evidence' ? ` as formal evidence${dis.evidence_type ? ` (${dis.evidence_type.toLowerCase().replaceAll('_', ' ')})` : ''}` : ''}, with the signed evidence pack attached.
                  </p>
                  <p className="mt-2 text-muted-foreground">{dis.response}</p>
                </div>
              ) : (
                <>
                  <textarea className={cn(field, 'mt-3 min-h-[140px]')} value={notes} maxLength={LIMITS.disputeNotes} onChange={(e) => setNotes(e.target.value)} placeholder="Draft with AI, then edit before sending" />
                  <div className="mt-1 text-right text-xs text-muted-foreground">{notes.length}/{LIMITS.disputeNotes}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="ghost" busy={busy === 'draft'} onClick={() => act('draft', async () => setNotes((await api.draftDispute(id)).notes))}>Draft response with AI</Button>
                    <Button busy={busy === 'send'} disabled={notes.trim().length < LIMITS.disputeMin || !!busy} onClick={() => act('send', () => api.submitDispute(id, notes))}>Send response + evidence to PayPal</Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span><strong>Buyer disputes?</strong> <span className="text-muted-foreground">e.g. "my AI assistant bought this without my permission"</span></span>
              {config.paypalMock ? (
                <Button variant="ghost" busy={busy === 'sim'} onClick={() => act('sim', () => api.simulateDispute(id))}>Simulate a buyer dispute</Button>
              ) : (
                <>
                  <Button variant="ghost" busy={busy === 'find'} onClick={() => act('find', () => api.findDispute(id))}>Find PayPal dispute</Button>
                  <span className="text-xs text-muted-foreground">Open it first as the sandbox buyer in the PayPal Resolution Center.</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <ErrorNote error={error} />
    </Panel>
  )
}

export function LogView({ config, decisions, reload }: { config: Config; decisions: Decision[]; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  useEffect(reload, []) // eslint-disable-line react-hooks/exhaustive-deps
  const captured = decisions.filter((d) => d.payment.action === 'captured')
  const voided = decisions.filter((d) => d.payment.action === 'voided')
  const held = decisions.filter((d) => !d.payment.action)
  const attacks = decisions.filter((d) => d.checks.some((c) => c.status === 'block' && (ATTACK.has(c.id) || c.id.startsWith('g_'))))
  const sum = (list: Decision[]) => list.reduce((s, d) => s + Number(d.order.total), 0)

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Captured" value={sum(captured)} prefix="$" decimals={2} icon={<Wallet className="size-4" />} tone="bg-teal-400/10 text-teal-300 ring-teal-400/30" />
        <Stat label="Blocked & released" value={sum(voided)} prefix="$" decimals={2} icon={<ShieldX className="size-4" />} tone="bg-rose-400/10 text-rose-300 ring-rose-400/30" />
        <Stat label="On hold" value={held.length} icon={<Timer className="size-4" />} tone="bg-amber-400/10 text-amber-300 ring-amber-400/30" />
        <Stat label="Attacks & scams stopped" value={attacks.length} icon={<ShieldCheck className="size-4" />} tone="bg-blue-400/10 text-blue-300 ring-blue-400/30" />
      </div>

      <AnimatePresence>{open && <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Evidence id={open} config={config} onClose={() => setOpen(null)} onChange={reload} /></motion.div>}</AnimatePresence>

      <Panel glow={false} className="p-0 sm:p-0">
        <div className="flex items-center justify-between px-5 pt-5 sm:px-6">
          <SectionTitle eyebrow="Audit trail" title="Every agent payment, and why" />
          <Button variant="subtle" onClick={reload}>Refresh</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-y border-border bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>{['When', 'Request', 'Shop', 'Amount', 'Outcome', 'Reason', ''].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decisions.length ? (
                decisions.map((d) => {
                  const o = d.payment.action ?? 'held'
                  const failed = d.checks.filter((c) => c.status !== 'pass')
                  const mcp = d.agent?.startsWith('external:')
                  return (
                    <tr key={d.id} className={cn('transition-colors hover:bg-muted/30', open === d.id && 'bg-blue-500/[.06]')}>
                      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{new Date(d.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="px-5 py-3">
                        <div className="max-w-[280px] truncate">{d.request}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">{assistantLabel(d.profileName)}{mcp && <Pill tone="info">via MCP: {d.agent.slice(9)}</Pill>}{d.agent === 'gemini' && <Pill tone="muted">Gemini agent</Pill>}</div>
                      </td>
                      <td className="px-5 py-3">{d.order.shop}</td>
                      <td className="whitespace-nowrap px-5 py-3 tabular-nums">{money(d.order.total, d.order.currency)}</td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Pill tone={o}>{o}</Pill>
                          {d.resolvedBy === 'shopper' && <span className="text-xs text-muted-foreground">by you</span>}
                          {d.resolvedBy === 'guardian' && <span className="text-xs text-muted-foreground">by {d.approver}</span>}
                          {d.dispute && <Pill tone="review">disputed</Pill>}
                        </div>
                      </td>
                      <td className="max-w-[280px] px-5 py-3 text-muted-foreground" title={failed.map((c) => c.label).join(', ')}>
                        {failed.length ? (
                          <span>
                            {failed.slice(0, 2).map((c) => c.label).join(' · ')}
                            {failed.length > 2 && <span className="ml-1 text-xs text-blue-300/80">+{failed.length - 2} more</span>}
                          </span>
                        ) : (
                          <span className="text-teal-300/80">all checks passed</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setOpen(d.id)} aria-label={`Evidence for ${d.request}`}>Evidence</Button>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">No agent payments yet. Run one in the Shopper tab.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
