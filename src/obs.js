// Observability: one JSON log line per event (easy to search in Render's log view), request ids,
// and in-process counters exposed at /api/metrics. No secrets or card data are ever logged.
import { randomUUID } from 'node:crypto';

const QUIET = process.env.NODE_ENV === 'test' || process.env.LOG_LEVEL === 'silent';
const startedAt = Date.now();

/** log('info', 'payment.captured', { orderId }) -> {"ts":..,"level":"info","event":"payment.captured","orderId":..} */
export function log(level, event, fields = {}) {
  if (QUIET && level !== 'error') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

// ---------------- metrics ----------------
const counters = new Map(); // "name{label=value}" -> count
const timings = new Map(); // name -> { count, totalMs, maxMs }

const key = (name, labels) => {
  const l = Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
  return l ? `${name}{${l}}` : name;
};

export function count(name, labels, n = 1) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + n);
}

export function timing(name, ms) {
  const t = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  t.count += 1;
  t.totalMs += ms;
  t.maxMs = Math.max(t.maxMs, ms);
  timings.set(name, t);
}

/** Time an async call: records latency and an ok/error counter, rethrows errors. */
export async function timed(name, labels, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    count(`${name}_total`, { ...labels, result: 'ok' });
    return r;
  } catch (e) {
    count(`${name}_total`, { ...labels, result: 'error' });
    throw e;
  } finally {
    timing(name, performance.now() - t0);
  }
}

export function metrics() {
  return {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    counters: Object.fromEntries([...counters].sort()),
    latency_ms: Object.fromEntries(
      [...timings].map(([k, t]) => [k, { count: t.count, avg: Math.round(t.totalMs / t.count), max: Math.round(t.maxMs) }]),
    ),
  };
}

// ---------------- request logging ----------------
/** Adds req.id (also returned as X-Request-Id) and logs every API request with status and latency. */
export function requestLogger(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  if (!req.path.startsWith('/api/')) return next();
  const t0 = performance.now();
  res.on('finish', () => {
    const ms = Math.round(performance.now() - t0);
    // Route pattern, not the raw URL, so ids don't explode the metric labels.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    count('http_requests_total', { route: `${req.method} ${route}`, status: res.statusCode });
    timing(`http ${req.method} ${route}`, ms);
    if (req.path === '/api/health') return;
    log(res.statusCode >= 500 ? 'error' : 'info', 'http.request', { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
}
