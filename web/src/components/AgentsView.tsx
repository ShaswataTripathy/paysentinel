import { useEffect, useState } from 'react'
import { Check, Copy, Plug } from 'lucide-react'
import { money, type Decision } from '@/api'
import { Panel, Pill, SectionTitle } from '@/components/kit'
import { AnimatedList } from '@/components/ui/animated-list'
import { BlurFade } from '@/components/ui/blur-fade'

const TOOLS = [
  ['create_mandate', "The user's own words become strict limits. Always first."],
  ['search_products', 'Browse every shop, verified or not, like the open web.'],
  ['get_product', 'Read a listing. Seller text is marked untrusted.'],
  ['checkout', 'Cart → PayPal hold → PaySentinel decides.'],
  ['complete_payment', 'Finish after the user approves on PayPal.'],
  ['get_decision', 'Check a payment waiting for approval.'],
]

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-border bg-[#05070d] p-4 pr-12 font-mono text-[12.5px] leading-relaxed text-slate-300">{text}</pre>
      <button
        onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) })}
        className="absolute right-2 top-2 rounded-lg border border-border bg-muted/70 p-1.5 text-muted-foreground opacity-70 transition hover:text-foreground group-hover:opacity-100"
        aria-label="Copy"
      >
        {done ? <Check className="size-4 text-teal-300" /> : <Copy className="size-4" />}
      </button>
    </div>
  )
}

export function AgentsView({ decisions, reload }: { decisions: Decision[]; reload: () => void }) {
  useEffect(() => {
    reload()
    const t = setInterval(reload, 4000) // live feed while the tab is open
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const origin = typeof window !== 'undefined' ? window.location.origin.replace(':5173', ':3000') : 'http://localhost:3000'
  const feed = decisions.filter((d) => d.agent?.startsWith('external:')).slice(0, 8)

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1.3fr_1fr]">
      <div className="grid gap-5">
        <Panel>
          <SectionTitle eyebrow="Model Context Protocol" title={<span className="flex items-center gap-2"><Plug className="size-5 text-blue-300" /> Any AI agent can pay through PaySentinel</span>}>
            Claude, Cursor, or an agent built with PayPal's Agent Toolkit connects to the PaySentinel MCP server. It shops however it likes; the money still goes through the hold → check → capture path, and the agent never decides about money.
          </SectionTitle>
          <div className="grid gap-3">
            <div className="text-sm font-medium">Claude Code</div>
            <CopyBlock text={`claude mcp add paysentinel --env PAYSENTINEL_URL=${origin} -- node path/to/paysentinel/src/mcp.js`} />
            <div className="text-sm font-medium">Claude Desktop · claude_desktop_config.json</div>
            <CopyBlock
              text={JSON.stringify({ mcpServers: { paysentinel: { command: 'node', args: ['path/to/paysentinel/src/mcp.js'], env: { PAYSENTINEL_URL: origin, PAYSENTINEL_AGENT_NAME: 'claude-desktop' } } } }, null, 2)}
            />
            <p className="text-sm text-muted-foreground">Then ask: <span className="text-foreground">"Use PaySentinel to buy one pack of AA batteries under $15."</span></p>
          </div>
        </Panel>
        <div className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map(([name, desc], i) => (
            <BlurFade key={name} delay={0.04 * i}>
              <Panel className="p-4 sm:p-4">
                <div className="font-mono text-sm text-blue-200">{name}</div>
                <div className="mt-1 text-sm text-muted-foreground">{desc}</div>
              </Panel>
            </BlurFade>
          ))}
        </div>
      </div>
      <Panel beam={feed.length > 0}>
        <SectionTitle eyebrow="Live" title="Payments from outside agents">Updates every few seconds.</SectionTitle>
        {feed.length ? (
          <AnimatedList delay={250} className="items-stretch">
            {feed.map((d) => {
              const o = d.payment.action ?? 'held'
              return (
                <div key={d.id} className="rounded-xl border border-border bg-background/50 p-3">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{d.agent.slice(9)}</span>
                    <Pill tone={o}>{o}</Pill>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">"{d.request}"</div>
                  <div className="mt-1 text-xs text-muted-foreground">{money(d.order.total, d.order.currency)} at {d.order.shop} · {new Date(d.at).toLocaleTimeString()}</div>
                </div>
              )
            })}
          </AnimatedList>
        ) : (
          <p className="text-sm text-muted-foreground">No MCP payments yet. Connect an agent, or run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">npm run mcp:smoke</code>.</p>
        )}
      </Panel>
    </div>
  )
}
