// shared components (animated parts from Magic UI, MIT)
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Check, CircleAlert, Loader2, X } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { MagicCard } from '@/components/ui/magic-card'
import { BorderBeam } from '@/components/ui/border-beam'
import type { CheckStatus } from '@/api'

export function Panel({ children, className, beam = false, glow = true }: { children: ReactNode; className?: string; beam?: boolean; glow?: boolean }) {
  const inner = <div className={cn('relative p-5 sm:p-6', className)}>{children}</div>
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card/70 backdrop-blur-sm">
      {glow ? (
        <MagicCard className="rounded-2xl" gradientColor="#1d4ed8" gradientOpacity={0.12} gradientFrom="#3b82f6" gradientTo="#2dd4bf" gradientSize={260}>
          {inner}
        </MagicCard>
      ) : (
        inner
      )}
      {beam && <BorderBeam size={120} duration={7} colorFrom="#60a5fa" colorTo="#2dd4bf" borderWidth={1.5} />}
    </div>
  )
}

type Variant = 'primary' | 'ghost' | 'good' | 'bad' | 'subtle'
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-blue-500 to-blue-600 text-white shadow-[0_0_0_1px_rgba(96,165,250,.4),0_8px_24px_-8px_rgba(59,130,246,.7)] hover:from-blue-400 hover:to-blue-600',
  ghost: 'border border-border bg-muted/60 text-foreground hover:bg-muted hover:border-blue-500/40',
  subtle: 'text-muted-foreground hover:text-foreground',
  good: 'bg-gradient-to-b from-teal-400 to-teal-500 text-slate-950 shadow-[0_8px_24px_-10px_rgba(45,212,191,.8)] hover:from-teal-300',
  bad: 'border border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; icon?: ReactNode }>(
  ({ variant = 'primary', busy, icon, className, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all duration-200 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'

const STATUS: Record<CheckStatus, { icon: ReactNode; cls: string }> = {
  pass: { icon: <Check className="size-3.5" strokeWidth={3} />, cls: 'bg-teal-400/15 text-teal-300 ring-teal-400/30' },
  review: { icon: <CircleAlert className="size-3.5" strokeWidth={2.5} />, cls: 'bg-amber-400/15 text-amber-300 ring-amber-400/30' },
  block: { icon: <X className="size-3.5" strokeWidth={3} />, cls: 'bg-rose-400/15 text-rose-300 ring-rose-400/30' },
}

export function StatusDot({ status }: { status: CheckStatus }) {
  const s = STATUS[status]
  return <span className={cn('grid size-6 shrink-0 place-items-center rounded-full ring-1', s.cls)}>{s.icon}</span>
}

const PILL: Record<string, string> = {
  captured: 'bg-teal-400/10 text-teal-300 ring-teal-400/30',
  capture: 'bg-teal-400/10 text-teal-300 ring-teal-400/30',
  voided: 'bg-rose-400/10 text-rose-300 ring-rose-400/30',
  void: 'bg-rose-400/10 text-rose-300 ring-rose-400/30',
  held: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  review: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  info: 'bg-blue-400/10 text-blue-300 ring-blue-400/30',
  muted: 'bg-muted text-muted-foreground ring-border',
}
export function Pill({ tone = 'muted', children, className }: { tone?: string; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1', PILL[tone] ?? PILL.muted, className)}>{children}</span>
}

export function SectionTitle({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4">
      {eyebrow && <div className="mb-1 text-xs font-semibold uppercase tracking-[.18em] text-blue-300/80">{eyebrow}</div>}
      <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">{title}</h2>
      {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
    </div>
  )
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null
  return (
    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
      {error}
    </motion.p>
  )
}

export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,.06)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,#000_40%,transparent_100%)]" />
      <motion.div
        initial={{ opacity: 0, y: -80 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
        className="absolute -top-56 left-1/2 h-[560px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(59,130,246,.28),rgba(45,212,191,.10)_55%,transparent)] blur-2xl"
      />
      <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-background to-transparent" />
    </div>
  )
}

export const field =
  'w-full rounded-xl border border-border bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20'
