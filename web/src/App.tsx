import { useCallback, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Code2, ScrollText, ShieldCheck, ShoppingBag, Store, Users, Plug } from 'lucide-react'
import { api, type Config, type Decision, type Profile } from '@/api'
import { Backdrop } from '@/components/kit'
import { Hero } from '@/components/Hero'
import { ShopperFlow } from '@/components/shopper/ShopperFlow'
import { GuardianView } from '@/components/GuardianView'
import { SellerView } from '@/components/SellerView'
import { LogView } from '@/components/LogView'
import { AgentsView } from '@/components/AgentsView'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'shopper', label: 'Shopper', icon: ShoppingBag },
  { id: 'guardian', label: 'Guardian', icon: Users },
  { id: 'seller', label: 'Seller · Shelf', icon: Store },
  { id: 'agents', label: 'Any agent (MCP)', icon: Plug },
  { id: 'log', label: 'Decision log', icon: ScrollText },
] as const
type Tab = (typeof TABS)[number]['id']

function ModeBadge({ live, label }: { live: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1', live ? 'bg-teal-400/10 text-teal-200 ring-teal-400/30' : 'bg-muted text-muted-foreground ring-border')}>
      <span className={cn('size-1.5 rounded-full', live ? 'animate-pulse bg-teal-300' : 'bg-slate-500')} />
      {label}
    </span>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('ps-tab') as Tab) || 'shopper'
    } catch {
      return 'shopper'
    }
  })
  const [config, setConfig] = useState<Config | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [shopNames, setShopNames] = useState<Record<string, { name: string; trusted: boolean }>>({})
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.config(), api.profiles(), api.shops(), api.decisions()])
      .then(([c, p, s, d]) => {
        setConfig(c)
        setProfiles(p.profiles)
        setCategories(p.categories)
        setShopNames(Object.fromEntries(s.map((x) => [x.id, { name: x.name, trusted: x.trusted }])))
        setDecisions(d)
      })
      .catch((e) => setBootError(e.message))
  }, [])

  const reload = useCallback(() => {
    api.decisions().then(setDecisions).catch(() => {})
  }, [])

  const go = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem('ps-tab', t)
    } catch {
      /* private mode */
    }
  }

  const pendingGuardian = decisions.filter((d) => d.decision === 'review' && !d.resolvedBy && d.approver !== 'you').length

  return (
    <div className="min-h-screen">
      <Backdrop />
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <a href="/" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-teal-400 text-slate-950 shadow-[0_0_24px_-6px_rgba(59,130,246,.8)]">
              <ShieldCheck className="size-5" strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight">PaySentinel</span>
          </a>
          <div className="flex items-center gap-2">
            {config && (
              <>
                <ModeBadge live={!config.paypalMock} label={config.paypalMock ? 'PayPal mock' : 'PayPal sandbox'} />
                <span className="hidden sm:inline-flex" title={config.aiModels ? `agent: ${config.aiModels.agent} · tasks: ${config.aiModels.tasks}` : ''}>
                  <ModeBadge live={!config.aiMock} label={config.aiMock ? 'AI offline' : 'Gemini'} />
                </span>
              </>
            )}
            <a href="https://github.com/ShaswataTripathy/paysentinel" target="_blank" rel="noreferrer" className="hidden rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:block" aria-label="Source code">
              <Code2 className="size-4" />
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <Hero config={config} />

        <nav className="sticky top-16 z-30 -mx-4 mb-6 overflow-x-auto bg-background/60 px-4 py-3 backdrop-blur-xl sm:mx-0 sm:rounded-2xl sm:px-0" role="tablist">
          <div className="inline-flex min-w-max gap-1 rounded-2xl border border-border bg-card/70 p-1.5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => go(id)}
                className={cn('relative flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors', tab === id ? 'text-white' : 'text-muted-foreground hover:text-foreground')}
              >
                {tab === id && <motion.span layoutId="tab-pill" transition={{ type: 'spring', stiffness: 380, damping: 32 }} className="absolute inset-0 rounded-xl bg-gradient-to-b from-blue-500/30 to-blue-600/20 ring-1 ring-blue-400/40" />}
                <Icon className="relative size-4" />
                <span className="relative">{label}</span>
                {id === 'guardian' && pendingGuardian > 0 && <span className="relative grid size-5 place-items-center rounded-full bg-amber-400 text-[11px] font-bold text-slate-950">{pendingGuardian}</span>}
              </button>
            ))}
          </div>
        </nav>

        {bootError && <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-4 text-rose-200">Could not reach the PaySentinel server: {bootError}</p>}
        {config && (
          /* Shopper stays mounted so an in-progress payment survives tab switches. */
          <div className={tab === 'shopper' ? '' : 'hidden'}>
            <ShopperFlow config={config} profiles={profiles} shopNames={shopNames} onDecision={reload} />
          </div>
        )}
        {config && tab !== 'shopper' && (
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {tab === 'guardian' && <GuardianView profiles={profiles} categories={categories} decisions={decisions} reload={reload} onProfile={(p) => setProfiles(profiles.map((x) => (x.id === p.id ? p : x)))} />}
            {tab === 'seller' && <SellerView />}
            {tab === 'agents' && <AgentsView decisions={decisions} reload={reload} />}
            {tab === 'log' && <LogView config={config} decisions={decisions} reload={reload} />}
          </motion.div>
        )}
      </main>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        PaySentinel · PayPal Orders v2 (AUTHORIZE) · Payments v2 · Disputes · Gemini · MCP. AI never makes the money decision.
      </footer>
    </div>
  )
}
