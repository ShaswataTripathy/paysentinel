// Typed client for the PaySentinel API (src/server.js). The backend owns every money decision;
// this UI only displays it.

export type CheckStatus = 'pass' | 'review' | 'block'
export interface Check { id: string; label: string; status: CheckStatus; detail: string }
export interface Item { sku: string; name: string; quantity: number; unit_price: number }
export interface Cart { shop: string | null; items: Item[]; total: number }
export interface TraceStep { step: string; detail: string; tool?: string; suspicious?: boolean }

export interface Config {
  paypalMock: boolean
  cardDemo: boolean
  aiMock: boolean
  aiModels: { agent: string; tasks: string } | null
  paypalClientId: string | null
}

export interface Mandate {
  id: string
  request: string
  summary: string
  must_match: string[]
  quantity: number
  max_unit_price: number
  max_total: number
  currency: string
  allowed_shops: string[]
  missing: string[]
  parsedBy?: 'gemini' | 'offline'
}

export interface Run { runId: string; agent: string; model?: string; trace: TraceStep[]; cart: Cart; fallback?: boolean }

export interface Dispute {
  dispute_id: string
  reason: string
  status: string
  stage?: string | null
  buyer_message?: string | null
  channel?: string | null
  evidence_type?: string | null
  response?: string
}

export interface Decision {
  id: string
  at: string
  request: string
  profileId: string
  profileName: string
  approver: string
  agent: string
  trace: TraceStep[]
  order: { id: string; shop: string; currency: string; total: number; items: Item[]; authorizationId: string }
  decision: 'capture' | 'review' | 'void'
  checks: Check[]
  payment: { status: string; action?: 'captured' | 'voided'; id?: string }
  explanation: string
  resolvedBy: 'sentinel' | 'shopper' | 'guardian' | null
  receipt?: { sha256: string; hmac: string; signed_at: string }
  dispute?: Dispute
}

export interface GuardianRules {
  allowed_categories: string[]
  blocked_categories: string[]
  per_order_limit: number
  weekly_limit: number
  verified_shops_only: boolean
}
export interface Profile { id: string; name: string; guardian?: { name: string; rules: GuardianRules } }

export interface ShopSummary { id: string; name: string; trusted: boolean; productCount: number }
export interface Scan { flagged: boolean; reasons: string[]; pushedSkus: string[] }
export interface Product { sku: string; name: string; price: number; stock: number; category?: string; description: string; scan: Scan }
export interface Shop { id: string; name: string; trusted: boolean; products: Product[]; removed?: { line: string; reasons: string[] }[] }

export interface EvidencePack {
  summary: string
  request: string
  on_behalf_of: string
  paypal: { order_id: string; authorization_id: string; capture_id: string | null; outcome: string | null }
  checks: { id: string; status: CheckStatus; detail: string }[]
  receipt: { sha256: string } | null
  receipt_valid: boolean
  [key: string]: unknown
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}

export const api = {
  config: () => call<Config>('GET', '/api/config'),
  profiles: () => call<{ profiles: Profile[]; categories: string[] }>('GET', '/api/profiles'),
  saveRules: (id: string, rules: Partial<GuardianRules>) => call<Profile>('PUT', `/api/profiles/${id}/rules`, rules),
  createMandate: (text: string, profileId: string) => call<Mandate>('POST', '/api/mandates', { text, profileId }),
  runAgent: (mandateId: string, agent: string, attack: boolean) => call<Run>('POST', `/api/mandates/${mandateId}/run`, { agent, attack }),
  checkout: (runId: string, method: 'paypal' | 'card') => call<{ orderId: string; approveUrl: string | null }>('POST', '/api/checkout', { runId, method }),
  authorize: (orderId: string) => call<Decision>('POST', `/api/orders/${encodeURIComponent(orderId)}/authorize`),
  resolve: (id: string, action: 'approve' | 'reject') => call<Decision>('POST', `/api/decisions/${id}/${action}`),
  decisions: () => call<Decision[]>('GET', '/api/decisions'),
  evidence: (id: string) => call<EvidencePack>('GET', `/api/decisions/${id}/evidence`),
  simulateDispute: (id: string) => call<Dispute>('POST', `/api/decisions/${id}/dispute/simulate`),
  findDispute: (id: string) => call<Dispute>('POST', `/api/decisions/${id}/dispute/find`),
  draftDispute: (id: string) => call<{ notes: string }>('POST', `/api/decisions/${id}/dispute/draft`),
  submitDispute: (id: string, notes: string) => call<Dispute>('POST', `/api/decisions/${id}/dispute/submit`, { notes }),
  shops: () => call<ShopSummary[]>('GET', '/api/shops'),
  shop: (id: string) => call<Shop>('GET', `/api/shops/${id}`),
  importShop: (name: string, products: string) => call<Shop>('POST', '/api/shelf/import', { name, products }),
}

export const money = (n: number, cur = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(Number(n) || 0)
