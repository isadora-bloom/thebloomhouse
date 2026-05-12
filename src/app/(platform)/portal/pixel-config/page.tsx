'use client'

/**
 * /portal/pixel-config — install the Bloom site pixel.
 *
 * Closes the cross-session attribution gap the TBH Report's coverage
 * disclosure currently calls out as the biggest hole. The pixel runs
 * on the venue's marketing site (NOT the Bloom platform) and ties
 * pre-form visits to the eventual form submission.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  Copy,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Activity,
  Code,
} from 'lucide-react'

interface PixelConfig {
  pixelIngestKey: string
  pixelInstalledAt: string | null
  recentVisitCount: number
  earliestVisitAt: string | null
}

export default function PixelConfigPage() {
  const [config, setConfig] = useState<PixelConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [rotating, setRotating] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/portal/pixel-config')
      if (!resp.ok) return
      const j = (await resp.json()) as { config: PixelConfig }
      setConfig(j.config)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const rotate = useCallback(async () => {
    if (!confirm('Rotate the pixel key? Your current snippet will stop sending data immediately. You must replace the snippet on your website.')) {
      return
    }
    setRotating(true)
    try {
      await fetch('/api/portal/pixel-config', { method: 'POST' })
      await load()
    } finally {
      setRotating(false)
    }
  }, [load])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--bh-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }
  if (!config) {
    return <div className="p-6 text-sm text-rose-700">Failed to load pixel config.</div>
  }

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://YOUR_BLOOM_DOMAIN'
  const snippet = `<script>
  window.BLOOM_PIXEL_KEY = "${config.pixelIngestKey}";
  window.BLOOM_PIXEL_ENDPOINT = "${origin}/api/v1/visit";
</script>
<script async src="${origin}/bloom-pixel.js"></script>`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="font-serif text-2xl text-[var(--bh-ink)]">Site pixel</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--bh-muted)]">
          Drop this snippet into the head of every page on your marketing
          site (NOT the Bloom platform — your actual venue website). It
          captures pre-form visits, ad-click identifiers, and UTM tags so
          first-touch attribution survives the days-long gap between an
          Instagram ad and a couple filling out your inquiry form.
        </p>
      </header>

      {/* Status */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg flex items-center gap-2">
            <Activity className="h-4 w-4" /> Status
          </h2>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <StatusCard
            label="Installation"
            value={config.pixelInstalledAt ? 'Live' : 'Not yet installed'}
            sub={
              config.pixelInstalledAt
                ? `First seen ${new Date(config.pixelInstalledAt).toLocaleDateString()}`
                : 'Paste the snippet into your site to start capturing.'
            }
            ok={!!config.pixelInstalledAt}
          />
          <StatusCard
            label="Last 30 days"
            value={config.recentVisitCount.toLocaleString()}
            sub="page views captured"
            ok={config.recentVisitCount > 0}
          />
          <StatusCard
            label="Earliest visit"
            value={
              config.earliestVisitAt
                ? new Date(config.earliestVisitAt).toLocaleDateString()
                : '—'
            }
            sub="Coverage starts here. Pre-pixel attribution is forensic-only."
            ok={!!config.earliestVisitAt}
          />
        </div>
      </section>

      {/* Snippet */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg flex items-center gap-2">
            <Code className="h-4 w-4" /> Embed snippet
          </h2>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-700" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy
              </>
            )}
          </button>
        </div>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-4 font-mono text-xs text-slate-100">
          {snippet}
        </pre>
        <p className="mt-3 text-xs text-[var(--bh-muted)]">
          Drop into <code>&lt;head&gt;</code> on every page of your
          marketing site. For Squarespace / Wix / Wordpress, use the
          custom-header injection. For Webflow, paste into Project Settings → Custom Code → Head.
        </p>
      </section>

      {/* What it captures */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg">What the pixel captures</h2>
        <ul className="mt-3 space-y-2 text-sm text-[var(--bh-ink)]">
          <li>
            <strong>UTM tags</strong> — utm_source, utm_medium, utm_campaign, utm_term,
            utm_content. Captured on every visit, preserved through every
            navigation, attached to the form submission that lands the lead.
          </li>
          <li>
            <strong>Ad-platform click IDs</strong> — gclid (Google Ads),
            fbclid (Meta), ttclid (TikTok), msclkid (Microsoft Ads). With
            the Google Ads OAuth integration, gclid lifts the actual
            keyword and match-type that triggered the click.
          </li>
          <li>
            <strong>Cross-session journeys</strong> — a first-party cookie
            (1-year max-age) ties a Monday Instagram-ad-click visit to a
            Wednesday direct-form-fill the same user makes.
          </li>
          <li>
            <strong>Privacy floor</strong> — IP and User-Agent are SHA-256
            hashed with a per-venue salt. No raw values stored. No PII
            captured until the form submission with name + email arrives.
          </li>
        </ul>
      </section>

      {/* Rotate */}
      <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-700" /> Rotate key
        </h2>
        <p className="mt-2 text-sm text-amber-900">
          Rotating immediately invalidates the current snippet. Visits
          will stop coming in until you replace the snippet on your
          site with the new key. Only rotate if you suspect the key has
          leaked beyond the public page source (it lives in HTML on
          purpose, so leaks are usually not actionable).
        </p>
        <button
          type="button"
          onClick={rotate}
          disabled={rotating}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {rotating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Rotate pixel key
        </button>
      </section>
    </div>
  )
}

function StatusCard({
  label,
  value,
  sub,
  ok,
}: {
  label: string
  value: string
  sub?: string
  ok?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        ok
          ? 'border-emerald-200 bg-emerald-50/40'
          : 'border-[var(--bh-line)] bg-white'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-[11px] text-[var(--bh-muted)]">{sub}</div>
      ) : null}
    </div>
  )
}
