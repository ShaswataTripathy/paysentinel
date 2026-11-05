import { useEffect, useState } from 'react'
import { HeartHandshake, ShieldAlert } from 'lucide-react'
import { api, money, type Decision, type GuardianRules, type Profile } from '@/api'
import { Button, ErrorNote, Panel, Pill, SectionTitle, StatusDot, field } from '@/components/kit'
import { BlurFade } from '@/components/ui/blur-fade'
import { cn } from '@/lib/utils'

const label = (c: string) => c.replace('_', ' ')
const itemsText = (d: Decision) => d.order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')

function Rules({ profile, categories, onSaved }: { profile: Profile; categories: string[]; onSaved: (p: Profile) => void }) {
  const [r, setR] = useState<GuardianRules>(profile.guardian!.rules)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toggle = (kind: 'allowed_categories' | 'blocked_categories', c: string) =>
    setR({ ...r, [kind]: r[kind].includes(c) ? r[kind].filter((x) => x !== c) : [...r[kind], c] })
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.saveRules(profile.id, r))
      setMsg('Saved. New payments use these rules.')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const Chips = ({ kind, tone }: { kind: 'allowed_categories' | 'blocked_categories'; tone: string }) => (
    <div className="flex flex-wrap gap-2">
      {categories.map((c) => {
        const on = r[kind].includes(c)
        return (
          <button
            key={c}
            onClick={() => toggle(kind, c)}
            aria-pressed={on}
            className={cn('rounded-full px-3 py-1 text-xs font-medium capitalize ring-1 transition', on ? tone : 'bg-muted/50 text-muted-foreground ring-border hover:text-foreground')}
          >
            {label(c)}
          </button>
        )
      })}
    </div>
  )
  return (
    <Panel>
      <SectionTitle eyebrow={`Set by ${profile.guardian!.name}`} title={`Rules for ${profile.name}`}>
        Enforced on every payment, even if {profile.name.split(' ')[0]} asks the assistant for something else.
      </SectionTitle>
      <div className="grid gap-5 lg:grid-cols-3">
        <div>
          <div className="mb-2 text-sm font-medium">Allowed without asking</div>
          <Chips kind="allowed_categories" tone="bg-teal-400/15 text-teal-200 ring-teal-400/40" />
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Always blocked</div>
          <Chips kind="blocked_categories" tone="bg-rose-400/15 text-rose-200 ring-rose-400/40" />
        </div>
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Per order, above this I approve (USD)</span>
            <input type="number" min={0} className={field} value={r.per_order_limit} onChange={(e) => setR({ ...r, per_order_limit: Number(e.target.value) })} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Weekly budget (USD)</span>
            <input type="number" min={0} className={field} value={r.weekly_limit} onChange={(e) => setR({ ...r, weekly_limit: Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-blue-500" checked={r.verified_shops_only} onChange={(e) => setR({ ...r, verified_shops_only: e.target.checked })} />
            Verified shops only
          </label>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={save} busy={busy}>Save rules</Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>
    </Panel>
  )
}

export function GuardianView({ profiles, categories, decisions, reload, onProfile }: { profiles: Profile[]; categories: string[]; decisions: Decision[]; reload: () => void; onProfile: (p: Profile) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(reload, []) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = decisions.filter((d) => d.approver && d.approver !== 'you')
  const pending = rows.filter((d) => d.decision === 'review' && !d.resolvedBy)
  const blocked = rows.filter((d) => d.payment.action === 'voided' && d.resolvedBy === 'sentinel')

  const resolve = async (id: string, action: 'approve' | 'reject') => {
    setBusy(id + action)
    setError(null)
    try {
      await api.resolve(id, action)
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Panel beam={pending.length > 0}>
          <SectionTitle eyebrow="Guardian" title={<span className="flex items-center gap-2"><HeartHandshake className="size-5 text-amber-300" /> Waiting for your approval</span>} />
          {pending.length ? (
            <div className="grid gap-3">
              {pending.map((d, i) => (
                <BlurFade key={d.id} delay={i * 0.05}>
                  <div className="rounded-xl border border-amber-400/25 bg-amber-400/[.04] p-4">
                    <div className="text-sm">
                      <strong>{d.profileName}</strong>'s assistant wants to pay <strong>{money(d.order.total, d.order.currency)}</strong> at {d.order.shop}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">"{d.request}" · {itemsText(d)}</div>
                    <ul className="mt-3 grid gap-1.5">
                      {d.checks.filter((c) => c.status !== 'pass').map((c) => (
                        <li key={c.id} className="flex items-start gap-2 text-sm"><StatusDot status={c.status} /><span className="text-slate-300">{c.detail}</span></li>
                      ))}
                    </ul>
                    <div className="mt-3 flex gap-2">
                      <Button variant="good" onClick={() => resolve(d.id, 'approve')} busy={busy === d.id + 'approve'}>Approve and pay</Button>
                      <Button variant="bad" onClick={() => resolve(d.id, 'reject')} busy={busy === d.id + 'reject'}>Reject</Button>
                    </div>
                  </div>
                </BlurFade>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing waiting. Payments over the limits will appear here, with the money held by PayPal.</p>
          )}
          <ErrorNote error={error} />
        </Panel>
        <Panel>
          <SectionTitle eyebrow="Protected" title={<span className="flex items-center gap-2"><ShieldAlert className="size-5 text-rose-300" /> Blocked for your family</span>} />
          {blocked.length ? (
            <div className="grid gap-3">
              {blocked.slice(0, 6).map((d) => (
                <div key={d.id} className="rounded-xl border border-rose-400/25 bg-rose-500/[.04] p-4">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span><strong>Blocked:</strong> {money(d.order.total, d.order.currency)} for {itemsText(d)}</span>
                    <Pill tone="voided">voided</Pill>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">"{d.request}" · {new Date(d.at).toLocaleString()}</div>
                  <p className="mt-2 text-sm text-slate-300">{d.explanation}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing blocked yet.</p>
          )}
        </Panel>
      </div>
      {profiles.filter((p) => p.guardian).map((p) => (
        <Rules key={p.id} profile={p} categories={categories} onSaved={onProfile} />
      ))}
    </div>
  )
}
