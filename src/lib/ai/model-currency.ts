/**
 * Stale-model check (Failure one).
 *
 * The cold-open failure: a model ID is retired, the provider announces it
 * 60 days ahead on a notice page, and the running code never hears about
 * it, because a notice page and a production constant were never
 * connected. Centralising the ID (one constant, one place) makes the fix a
 * one-liner, but it doesn't make the fix happen. This is what makes it
 * happen: on a schedule, list the models each provider currently serves
 * and check that every model ID the code is configured to call still
 * appears. If one has gone missing, alert the operator, before a button
 * goes dead rather than after.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  CLAUDE_MODEL,
  HAIKU_MODEL,
  OPUS_MODEL,
  OPENAI_FALLBACK_MODEL,
} from '@/lib/ai/client'
import { alertModelStale } from '@/lib/ai/alert-fallback'

export interface ProviderModelReport {
  provider: 'anthropic' | 'openai'
  /** True when every configured model for this provider is still served. */
  ok: boolean
  /** Model IDs the code is configured to call for this provider. */
  configured: string[]
  /** Configured IDs that no longer appear in the provider's current list. */
  stale: string[]
  /** Count of models the provider currently serves (for sanity). */
  available?: number
  /** Set when the check itself could not run (no key, network error). */
  error?: string
}

async function anthropicReport(): Promise<ProviderModelReport> {
  const configured = Array.from(new Set([CLAUDE_MODEL, HAIKU_MODEL, OPUS_MODEL]))
  if (!process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', ok: false, configured, stale: [], error: 'ANTHROPIC_API_KEY not set' }
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const available = new Set<string>()
    // .list() auto-paginates; iterate every page.
    for await (const model of client.models.list()) {
      available.add(model.id)
    }
    const stale = configured.filter((id) => !available.has(id))
    return { provider: 'anthropic', ok: stale.length === 0, configured, stale, available: available.size }
  } catch (err) {
    return {
      provider: 'anthropic',
      ok: false,
      configured,
      stale: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function openaiReport(): Promise<ProviderModelReport> {
  const configured = [OPENAI_FALLBACK_MODEL]
  if (!process.env.OPENAI_API_KEY) {
    return { provider: 'openai', ok: false, configured, stale: [], error: 'OPENAI_API_KEY not set' }
  }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const available = new Set<string>()
    for await (const model of client.models.list()) {
      available.add(model.id)
    }
    const stale = configured.filter((id) => !available.has(id))
    return { provider: 'openai', ok: stale.length === 0, configured, stale, available: available.size }
  } catch (err) {
    return {
      provider: 'openai',
      ok: false,
      configured,
      stale: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface ModelCurrencyReport {
  /** True only when every configured model on every provider is still served. */
  ok: boolean
  checkedAt: string
  providers: ProviderModelReport[]
}

/**
 * Run the check across both providers and alert on any stale ID. Returns a
 * structured report so a cron job or a health route can surface it.
 * A provider whose check couldn't run (missing key, network) is reported
 * ok:false with an `error`, but that is not treated as a stale model, so a
 * transient outage of the check itself doesn't page a false alarm.
 */
export async function checkModelCurrency(): Promise<ModelCurrencyReport> {
  const providers = await Promise.all([anthropicReport(), openaiReport()])

  const stale = providers.flatMap((p) => p.stale.map((id) => ({ provider: p.provider, id })))
  if (stale.length > 0) {
    void alertModelStale(stale)
  }

  const ok = providers.every((p) => p.ok)
  return { ok, checkedAt: new Date().toISOString(), providers }
}
