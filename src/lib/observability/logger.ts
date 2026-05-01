/**
 * Structured logger (T1-G / OPS-21.2.1 / Playbook 21.5.4).
 *
 * Single line of JSON per log call so Vercel + Datadog auto-parse.
 * Required field schema per Playbook 21.5.4:
 *   - level                 'debug' | 'info' | 'warn' | 'error'
 *   - msg                   short human label, lowercase, kebab-cased
 *   - venue_id              uuid (or null when pre-auth / cross-venue)
 *   - event_type            domain category ('email_pipeline.classify',
 *                           'sage.generate', 'autonomous_sender.gate', …)
 *   - correlation_id        request-scoped uuid; ties cost rows /
 *                           draft / interaction / engagement_event /
 *                           notification all back to one inbound event
 *   - actor                 who/what produced the log: 'system' /
 *                           'user:<uuid>' / 'cron:<job>' / 'gmail_pull'
 *   - outcome               'ok' | 'fail' | 'skip' | 'retry'
 *   - latency_ms            elapsed ms for the operation, when known
 *
 * Plus arbitrary `data` payload of additional context.
 *
 * PII redaction: every string field passes through redactObject before
 * stdout. `data` payloads carrying tier-1 content (transcripts, family
 * context, Stripe payloads) get scrubbed of the common email / phone /
 * card / long-quoted-string shapes.
 *
 * Usage:
 *
 *   const log = createLogger({ venueId, correlationId, actor: 'gmail_pull' })
 *   log.info('email.classified', { event_type: 'email_pipeline.classify',
 *                                   outcome: 'ok', latency_ms: 137,
 *                                   data: { classification: 'new_inquiry' } })
 *
 * Or, when you only have ad-hoc context (script, one-off path):
 *
 *   logEvent({ level: 'warn', msg: 'cron.run',
 *              event_type: 'cron.email_poll', outcome: 'skip',
 *              data: { reason: 'paused' } })
 *
 * For migrating console.* calls cheaply: keep the call shape similar
 * (level matches console.log/.warn/.error; msg is the leading string).
 *
 * Per BUILD-PLAN T1-G + Playbook OPS-21.2.1.
 */

import { redactObject, redact } from './redact'
import { randomUUID } from 'node:crypto'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogOutcome = 'ok' | 'fail' | 'skip' | 'retry'

export interface LogContext {
  /** Per-venue scope. Null for pre-auth / cross-venue cron sweeps. */
  venueId?: string | null
  /** Request-scoped uuid that ties downstream rows back to the
   *  originating inbound event. Reuse one ID across the whole
   *  processIncomingEmail / sage-route / cron-run cycle. */
  correlationId?: string | null
  /** Who produced the log line. Examples: 'system', 'gmail_pull',
   *  'cron:cost_ceiling_check', 'user:<uuid>'. */
  actor?: string
}

export interface LogEvent {
  level: LogLevel
  /** Short human label, lowercase, dot or hyphen separated. */
  msg: string
  /** Domain category — use a stable string so Datadog dashboards can
   *  group by it. Examples: 'email_pipeline.classify',
   *  'sage.forbidden_topic', 'autonomous_sender.gate'. */
  event_type?: string
  outcome?: LogOutcome
  latency_ms?: number
  /** Free-form additional context. Goes through PII redaction. */
  data?: Record<string, unknown>
}

interface FullEnvelope extends LogEvent {
  ts: string
  venue_id: string | null
  correlation_id: string | null
  actor: string
}

function emit(envelope: FullEnvelope): void {
  // One-line JSON. Vercel + Datadog parse this natively. Pre-redact
  // the `data` payload + any string fields to scrub PII shapes — we
  // can't audit every callsite so the logger is the last guard.
  const redacted: FullEnvelope = {
    ...envelope,
    msg: redact(envelope.msg),
    data: envelope.data ? (redactObject(envelope.data) as Record<string, unknown>) : undefined,
  }
  const line = JSON.stringify(redacted)
  // Route by level so Vercel surfaces warn/error in the deploy log
  // alerts. console.* is the right primitive — Vercel pipes them all
  // to the deployment log feed and filters by level there.
  if (envelope.level === 'error') {
    console.error(line)
  } else if (envelope.level === 'warn') {
    console.warn(line)
  } else if (envelope.level === 'debug') {
    // debug stays at console.log so it doesn't show in Vercel's
    // default warn/error deploy filter.
    console.log(line)
  } else {
    console.log(line)
  }
}

export interface Logger {
  debug(msg: string, fields?: Omit<LogEvent, 'level' | 'msg'>): void
  info(msg: string, fields?: Omit<LogEvent, 'level' | 'msg'>): void
  warn(msg: string, fields?: Omit<LogEvent, 'level' | 'msg'>): void
  error(msg: string, fields?: Omit<LogEvent, 'level' | 'msg'>): void
  /** Return a child logger with extra context baked in. */
  child(extra: Partial<LogContext>): Logger
  /** Read the bound correlation ID — useful for downstream stamping
   *  (api_costs.correlation_id, drafts metadata). */
  correlationId: string | null
  venueId: string | null
}

export function createLogger(context: LogContext = {}): Logger {
  const ctx: Required<LogContext> = {
    venueId: context.venueId ?? null,
    correlationId: context.correlationId ?? null,
    actor: context.actor ?? 'system',
  }

  function log(level: LogLevel, msg: string, fields?: Omit<LogEvent, 'level' | 'msg'>): void {
    emit({
      ts: new Date().toISOString(),
      level,
      msg,
      venue_id: ctx.venueId,
      correlation_id: ctx.correlationId,
      actor: ctx.actor,
      event_type: fields?.event_type,
      outcome: fields?.outcome,
      latency_ms: fields?.latency_ms,
      data: fields?.data,
    })
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child(extra) {
      return createLogger({ ...ctx, ...extra })
    },
    get correlationId() { return ctx.correlationId },
    get venueId() { return ctx.venueId },
  }
}

/**
 * One-off log emission without a logger handle. Use sparingly —
 * preference is to thread a logger through. Useful for cron-run
 * top-level entrypoints and migration scripts.
 */
export function logEvent(envelope: LogEvent & Partial<LogContext>): void {
  emit({
    ts: new Date().toISOString(),
    level: envelope.level,
    msg: envelope.msg,
    venue_id: envelope.venueId ?? null,
    correlation_id: envelope.correlationId ?? null,
    actor: envelope.actor ?? 'system',
    event_type: envelope.event_type,
    outcome: envelope.outcome,
    latency_ms: envelope.latency_ms,
    data: envelope.data,
  })
}

/**
 * Mint a fresh correlation_id. Use at the entry point of an inbound
 * event so every downstream log + DB write can reference the same
 * lineage. Safe in Node 24 (Vercel runtime) and Edge Functions.
 */
export function newCorrelationId(): string {
  return randomUUID()
}
