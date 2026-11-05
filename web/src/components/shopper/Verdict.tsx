import { useState } from 'react'
import { motion } from 'motion/react'
import { BadgeCheck, CircleSlash, Hourglass } from 'lucide-react'
import { api, type Decision } from '@/api'
import { Button, ErrorNote, StatusDot } from '@/components/kit'
import { BlurFade } from '@/components/ui/blur-fade'
import { NumberTicker } from '@/components/ui/number-ticker'
import { ShineBorder } from '@/components/ui/shine-border'
import { cn } from '@/lib/utils'

/** The decision as the shopper sees it now (a resolved review shows its final outcome). */
export const outcome = (d: Decision): 'capture' | 'void' | 'review' =>
  d.decision === 'review' && d.resolvedBy ? (d.payment.action === 'captured' ? 'capture' : 'void') : d.decision

const LOOK = {
  capture: { title: 'Payment captured', sub: 'Every check passed, so PayPal charged the held amount.', icon: BadgeCheck, shine: ['#2dd4bf', '#60a5fa'], text: 'text-teal-300', bg: 'from-teal-400/[.10]' },
  void: { title: 'Payment blocked', sub: 'PayPal released the held money. Nothing was charged.', icon: CircleSlash, shine: ['#fb7185', '#f97316'], text: 'text-rose-300', bg: 'from-rose-500/[.10]' },
  review: { title: 'Needs your approval', sub: 'The money is still on hold. You decide.', icon: Hourglass, shine: ['#fbbf24', '#f59e0b'], text: 'text-amber-300', bg: 'from-amber-400/[.10]' },
}

export function Verdict({ decision: d, onChange }: { decision: Decision; onChange: (d: Decision) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = outcome(d)
  const look = LOOK[key]
  const toGuardian = d.approver && d.approver !== 'you'
  let title = look.title
  if (key === 'review' && toGuardian) title = `Sent to ${d.approver} for approval`
  if (d.resolvedBy === 'guardian') title += ` by ${d.approver}`
  if (d.resolvedBy === 'shopper') title += ' by you'
  const guardianAlert = toGuardian && key === 'void' && d.checks.some((c) => c.id.startsWith('g_') && c.status === 'block')
  const Icon = look.icon
  const passed = d.checks.filter((c) => c.status === 'pass').length

  const resolve = async (action: 'approve' | 'reject') => {
    setBusy(action)
    setError(null)
    try {
      onChange(await api.resolve(d.id, action))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <motion.div
        key={key + (d.resolvedBy ?? '')}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
        className={cn('relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br to-transparent p-5 sm:p-6', look.bg)}
      >
        <ShineBorder shineColor={look.shine} borderWidth={1.5} duration={10} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className={cn('grid size-12 place-items-center rounded-2xl bg-background/60 ring-1 ring-border', look.text)}>
              <Icon className="size-6" />
            </span>
            <div>
              <div className={cn('text-xl font-bold tracking-tight sm:text-2xl', look.text)}>{title}</div>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-slate-300">{d.explanation || look.sub}</p>
              {guardianAlert && <p className="mt-2 text-sm font-semibold text-rose-200">{d.approver} has been alerted.</p>}
              {key === 'review' && toGuardian && <p className="mt-2 text-sm text-amber-200/90">The money stays on hold until {d.approver} decides in the Guardian tab.</p>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{key === 'capture' ? 'Charged' : key === 'void' ? 'Released' : 'On hold'}</div>
            <div className="text-3xl font-extrabold tabular-nums">
              $<NumberTicker value={d.order.total} decimalPlaces={2} className="text-foreground" />
            </div>
            <div className="text-xs text-muted-foreground">
              {passed}/{d.checks.length} checks passed
            </div>
          </div>
        </div>
        {d.decision === 'review' && !d.resolvedBy && !toGuardian && (
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="good" onClick={() => resolve('approve')} busy={busy === 'approve'}>
              Approve and pay
            </Button>
            <Button variant="bad" onClick={() => resolve('reject')} busy={busy === 'reject'}>
              Reject, release the money
            </Button>
          </div>
        )}
      </motion.div>
      <ErrorNote error={error} />

      <ul className="mt-5 grid gap-2 sm:grid-cols-2">
        {d.checks.map((c, i) => (
          <BlurFade key={c.id} delay={0.05 + i * 0.06} inView={false}>
            <li
              className={cn(
                'flex h-full items-start gap-3 rounded-xl border bg-background/40 p-3',
                c.status === 'pass' ? 'border-border' : c.status === 'review' ? 'border-amber-400/25' : 'border-rose-400/30 bg-rose-500/[.04]',
              )}
            >
              <StatusDot status={c.status} />
              <div className="text-sm">
                <div className="font-medium">{c.label}</div>
                <div className="text-muted-foreground">{c.detail}</div>
              </div>
            </li>
          </BlurFade>
        ))}
      </ul>
      <div className="mt-4 break-all font-mono text-[11px] text-muted-foreground">
        PayPal order {d.order.id} · authorization {d.order.authorizationId} · {d.payment.action ?? 'held'}
        {d.payment.id ? ` · capture ${d.payment.id}` : ''}
      </div>
    </div>
  )
}
