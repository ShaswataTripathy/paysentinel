import { forwardRef, useRef, type ReactNode } from 'react'
import { Bot, MessageSquareText, ShieldCheck, Store, Wallet } from 'lucide-react'
import { AnimatedBeam } from '@/components/ui/animated-beam'
import { AnimatedShinyText } from '@/components/ui/animated-shiny-text'
import { BlurFade } from '@/components/ui/blur-fade'
import { cn } from '@/lib/utils'
import type { Config } from '@/api'

const Node = forwardRef<HTMLDivElement, { children: ReactNode; label: string; className?: string }>(({ children, label, className }, ref) => (
  <div className="flex flex-col items-center gap-2">
    <div
      ref={ref}
      className={cn(
        'z-10 grid size-12 place-items-center rounded-2xl border border-border bg-card text-slate-200 shadow-[0_0_24px_-8px_rgba(96,165,250,.5)] sm:size-14',
        className,
      )}
    >
      {children}
    </div>
    <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
  </div>
))
Node.displayName = 'Node'

function FlowDiagram() {
  const box = useRef<HTMLDivElement>(null)
  const you = useRef<HTMLDivElement>(null)
  const agent = useRef<HTMLDivElement>(null)
  const shop = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const paypal = useRef<HTMLDivElement>(null)
  const beam = { containerRef: box, gradientStartColor: '#60a5fa', gradientStopColor: '#2dd4bf', pathColor: '#64748b', pathOpacity: 0.18, duration: 4 }
  return (
    <div ref={box} className="relative mx-auto flex w-full max-w-md items-center justify-between px-2 py-4">
      <div className="flex flex-col gap-5">
        <Node ref={you} label="Your words"><MessageSquareText className="size-5" /></Node>
        <Node ref={agent} label="AI agent"><Bot className="size-5" /></Node>
        <Node ref={shop} label="Shop listing"><Store className="size-5" /></Node>
      </div>
      <Node ref={sentinel} label="PaySentinel" className="size-16 border-blue-400/40 bg-gradient-to-br from-blue-500/25 to-teal-400/15 text-blue-200 sm:size-20">
        <ShieldCheck className="size-8" />
      </Node>
      <Node ref={paypal} label="PayPal hold"><Wallet className="size-5" /></Node>
      <AnimatedBeam {...beam} fromRef={you} toRef={sentinel} curvature={-60} />
      <AnimatedBeam {...beam} fromRef={agent} toRef={sentinel} delay={0.4} />
      <AnimatedBeam {...beam} fromRef={shop} toRef={sentinel} curvature={60} delay={0.8} gradientStartColor="#fb7185" gradientStopColor="#fbbf24" />
      <AnimatedBeam {...beam} fromRef={sentinel} toRef={paypal} delay={1.2} />
    </div>
  )
}

export function Hero({ config }: { config: Config | null }) {
  const live = config && !config.paypalMock
  return (
    <section className="grid items-center gap-8 pb-6 pt-10 lg:grid-cols-[1.15fr_1fr] lg:pt-14">
      <div>
        <BlurFade delay={0.05}>
          <div className="mb-5 inline-flex rounded-full border border-border bg-card/60 px-3 py-1 text-xs backdrop-blur">
            <AnimatedShinyText className="mx-0 max-w-none text-xs text-muted-foreground">
              {live ? 'Live on PayPal sandbox' : 'Demo mode'} · Gemini agents · MCP for any AI agent
            </AnimatedShinyText>
          </div>
        </BlurFade>
        <BlurFade delay={0.12}>
          <h1 className="text-balance text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            Let AI agents shop with your PayPal.{' '}
            <span className="bg-gradient-to-r from-blue-300 via-sky-300 to-teal-300 bg-clip-text text-transparent">Never unwatched.</span>
          </h1>
        </BlurFade>
        <BlurFade delay={0.2}>
          <p className="mt-5 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Agents get tricked by hidden text, price switches and extra items. PaySentinel has PayPal <span className="text-foreground">hold</span> every agent
            payment, <span className="text-foreground">checks</span> it against what you actually asked for, then{' '}
            <span className="text-teal-300">captures</span>, <span className="text-amber-300">asks you</span> or <span className="text-rose-300">voids</span> it.
          </p>
        </BlurFade>
      </div>
      <BlurFade delay={0.25}>
        <FlowDiagram />
      </BlurFade>
    </section>
  )
}
