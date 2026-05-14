'use client'

/**
 * Settings → Venue Info
 *
 * Coordinator surface to populate venue address + day-of logistics. The
 * fields here flow through to the couple-portal /venue-info page via the
 * `venues` table:
 *   - address_line1 / city / state / zip / latitude / longitude (mig 008)
 *   - parking_instructions / entry_instructions / day_of_contact_name /
 *     day_of_contact_phone (mig 221)
 *
 * Tier-B audit #52 closure. Latitude/longitude are coordinator-only —
 * if populated they take precedence over the formatted-address geocode
 * on the public-facing Google Maps link.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import {
  Save,
  MapPin,
  Loader2,
  Check,
  Wand2,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Star,
  RefreshCw,
} from 'lucide-react'

interface VenueLocation {
  address_line1: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  parking_instructions: string | null
  entry_instructions: string | null
  day_of_contact_name: string | null
  day_of_contact_phone: string | null
  // Wave 8 — external-signal config derived from address
  google_trends_metro: string | null
  noaa_station_id: string | null
  census_fips: string | null
  metro_msa_code: string | null
  dc_region_proxy: boolean | null
  location_derived_at: string | null
  // TIER 7e (2026-05-14): Google Place ID for review polling.
  google_place_id: string | null
  // TIER 7+ (2026-05-14): other review platform URLs / IDs. These have no
  // public APIs so ingestion is paste-only, but storing them powers the
  // "open on each platform" link strip on /intel/reviews.
  the_knot_url: string | null
  wedding_wire_url: string | null
  zola_url: string | null
  yelp_business_id: string | null
  facebook_page_id: string | null
}

interface OwnerPresence {
  // Couple-facing presence fields (mig 222) live on venue_config, not venues.
  // Owner NAME is read from venue_ai_config.owner_name elsewhere — this form
  // edits the note + photo only since name editing already lives on the AI
  // personality settings page.
  owner_note_to_couples: string | null
  owner_photo_url: string | null
}

const EMPTY: VenueLocation = {
  address_line1: '',
  city: '',
  state: '',
  zip: '',
  latitude: null,
  longitude: null,
  parking_instructions: '',
  entry_instructions: '',
  day_of_contact_name: '',
  day_of_contact_phone: '',
  google_trends_metro: null,
  noaa_station_id: null,
  census_fips: null,
  metro_msa_code: null,
  dc_region_proxy: null,
  location_derived_at: null,
  google_place_id: null,
  the_knot_url: null,
  wedding_wire_url: null,
  zola_url: null,
  yelp_business_id: null,
  facebook_page_id: null,
}

interface DerivePreview {
  field: string
  current: unknown
  proposed: unknown
  willWrite: boolean
}

const EMPTY_OWNER: OwnerPresence = {
  owner_note_to_couples: '',
  owner_photo_url: '',
}

export default function VenueInfoSettingsPage() {
  const { venueId, level: scopeLevel } = useScope()
  const supabase = createClient()
  const [data, setData] = useState<VenueLocation>(EMPTY)
  const [owner, setOwner] = useState<OwnerPresence>(EMPTY_OWNER)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Wave 8 — auto-derive state
  const [derivePreviewing, setDerivePreviewing] = useState(false)
  const [deriveApplying, setDeriveApplying] = useState(false)
  const [derivePreview, setDerivePreview] = useState<DerivePreview[] | null>(null)
  const [deriveErrors, setDeriveErrors] = useState<string[]>([])
  // TIER 7+ (2026-05-14) — Google Place ID test + on-demand refresh
  const [placeIdTesting, setPlaceIdTesting] = useState(false)
  const [placeIdTestResult, setPlaceIdTestResult] = useState<
    | { ok: true; name?: string; address?: string }
    | { ok: false; error: string }
    | null
  >(null)
  const [googlePulling, setGooglePulling] = useState(false)
  const [googlePullResult, setGooglePullResult] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    async function load() {
      const [venueRes, configRes] = await Promise.all([
        supabase
          .from('venues')
          .select(
            'address_line1, city, state, zip, latitude, longitude, parking_instructions, entry_instructions, day_of_contact_name, day_of_contact_phone, google_trends_metro, noaa_station_id, census_fips, metro_msa_code, dc_region_proxy, location_derived_at, google_place_id, the_knot_url, wedding_wire_url, zola_url, yelp_business_id, facebook_page_id',
          )
          .eq('id', venueId)
          .maybeSingle(),
        supabase
          .from('venue_config')
          .select('owner_note_to_couples, owner_photo_url')
          .eq('venue_id', venueId)
          .maybeSingle(),
      ])
      if (cancelled) return
      // Round-6 audit fix: was `if/else if` which silently dropped
      // configRes.error when venuesRes.error fired. Surface both.
      const errs: string[] = []
      if (venueRes.error) errs.push(`venues: ${venueRes.error.message}`)
      if (configRes.error) errs.push(`venue_config: ${configRes.error.message}`)
      if (errs.length > 0) setError(errs.join(' | '))
      setData((venueRes.data as VenueLocation | null) ?? EMPTY)
      setOwner((configRes.data as OwnerPresence | null) ?? EMPTY_OWNER)
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [venueId, supabase])

  async function save() {
    if (!venueId) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const venuesPayload = {
      address_line1: data.address_line1 || null,
      city: data.city || null,
      state: data.state || null,
      zip: data.zip || null,
      latitude: data.latitude,
      longitude: data.longitude,
      parking_instructions: data.parking_instructions || null,
      entry_instructions: data.entry_instructions || null,
      day_of_contact_name: data.day_of_contact_name || null,
      day_of_contact_phone: data.day_of_contact_phone || null,
      // Wave 8 — derived fields are saved alongside address. Operator
      // overrides on these are preserved (only the auto-derive endpoint
      // fills nulls; manual save writes whatever's in the form).
      google_trends_metro: data.google_trends_metro || null,
      noaa_station_id: data.noaa_station_id || null,
      census_fips: data.census_fips || null,
      metro_msa_code: data.metro_msa_code || null,
      dc_region_proxy: data.dc_region_proxy,
      google_place_id: data.google_place_id || null,
      the_knot_url: data.the_knot_url || null,
      wedding_wire_url: data.wedding_wire_url || null,
      zola_url: data.zola_url || null,
      yelp_business_id: data.yelp_business_id || null,
      facebook_page_id: data.facebook_page_id || null,
    }
    const configPayload = {
      owner_note_to_couples: owner.owner_note_to_couples || null,
      owner_photo_url: owner.owner_photo_url || null,
    }
    // Two parallel updates — venue_config and venues are independent
    // tables. Promise.all so the user sees one success/failure decision
    // rather than a half-saved state if both round-trips were sequential
    // and the second failed mid-flight.
    const [venuesRes, configRes] = await Promise.all([
      supabase.from('venues').update(venuesPayload).eq('id', venueId),
      supabase.from('venue_config').update(configPayload).eq('venue_id', venueId),
    ])
    setSaving(false)
    if (venuesRes.error) {
      setError(venuesRes.error.message)
      return
    }
    if (configRes.error) {
      setError(configRes.error.message)
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  function set<K extends keyof VenueLocation>(key: K, value: VenueLocation[K]) {
    setData((prev) => ({ ...prev, [key]: value }))
  }

  // ---------- Wave 8 — auto-derive handlers ----------
  async function handlePreviewDerive() {
    if (!venueId) return
    setDerivePreviewing(true)
    setDerivePreview(null)
    setDeriveErrors([])
    try {
      const resp = await fetch(`/api/admin/venue/location/preview?venueId=${venueId}`)
      const json = (await resp.json()) as {
        ok?: boolean
        error?: string
        diffs?: DerivePreview[]
        preview?: { errors?: string[] }
      }
      if (!resp.ok || !json.ok) {
        setError(json.error ?? `Preview failed (HTTP ${resp.status})`)
        return
      }
      setDerivePreview(json.diffs ?? [])
      setDeriveErrors(json.preview?.errors ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Preview error: ${msg}`)
    } finally {
      setDerivePreviewing(false)
    }
  }

  async function handleTestPlaceId() {
    const id = (data.google_place_id ?? '').trim()
    if (!id) {
      setPlaceIdTestResult({ ok: false, error: 'Paste a Place ID first.' })
      return
    }
    setPlaceIdTesting(true)
    setPlaceIdTestResult(null)
    try {
      const resp = await fetch('/api/intel/reviews/google-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ place_id: id }),
      })
      const json = (await resp.json()) as {
        ok?: boolean
        display_name?: string
        formatted_address?: string
        error?: string
      }
      if (!resp.ok || !json.ok) {
        setPlaceIdTestResult({
          ok: false,
          error: json.error ?? `Validation failed (HTTP ${resp.status})`,
        })
        return
      }
      setPlaceIdTestResult({
        ok: true,
        name: json.display_name,
        address: json.formatted_address,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPlaceIdTestResult({ ok: false, error: msg })
    } finally {
      setPlaceIdTesting(false)
    }
  }

  async function handleGooglePullNow() {
    const id = (data.google_place_id ?? '').trim()
    if (!id) {
      setGooglePullResult('Paste and save a Place ID first.')
      return
    }
    setGooglePulling(true)
    setGooglePullResult(null)
    try {
      const resp = await fetch('/api/intel/reviews/google-pull', { method: 'POST' })
      const json = (await resp.json()) as {
        ok?: boolean
        reviews_fetched?: number
        reviews_inserted?: number
        error?: string
      }
      if (!resp.ok || !json.ok) {
        setGooglePullResult(json.error ?? `Pull failed (HTTP ${resp.status})`)
        return
      }
      setGooglePullResult(
        `Pulled ${json.reviews_fetched ?? 0} from Google · ${json.reviews_inserted ?? 0} new (rest were already on file).`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setGooglePullResult(`Pull error: ${msg}`)
    } finally {
      setGooglePulling(false)
    }
  }

  async function handleApplyDerive() {
    if (!venueId) return
    setDeriveApplying(true)
    try {
      const resp = await fetch('/api/admin/venue/location/auto-derive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId, forceOverwrite: false }),
      })
      const json = (await resp.json()) as {
        ok?: boolean
        error?: string
        derivation?: {
          google_trends_metro: string | null
          noaa_station_id: string | null
          census_fips: string | null
          metro_msa_code: string | null
          dc_region_proxy: boolean | null
          latitude: number | null
          longitude: number | null
          errors: string[]
        }
        fieldsWritten?: string[]
      }
      if (!resp.ok || !json.ok) {
        setError(json.error ?? `Auto-derive failed (HTTP ${resp.status})`)
        return
      }
      // Refresh the form with what we just wrote.
      if (json.derivation) {
        setData((prev) => ({
          ...prev,
          google_trends_metro: prev.google_trends_metro ?? json.derivation!.google_trends_metro,
          noaa_station_id: prev.noaa_station_id ?? json.derivation!.noaa_station_id,
          census_fips: prev.census_fips ?? json.derivation!.census_fips,
          metro_msa_code: prev.metro_msa_code ?? json.derivation!.metro_msa_code,
          dc_region_proxy: prev.dc_region_proxy ?? json.derivation!.dc_region_proxy,
          latitude: prev.latitude ?? json.derivation!.latitude,
          longitude: prev.longitude ?? json.derivation!.longitude,
          location_derived_at: new Date().toISOString(),
        }))
        setDeriveErrors(json.derivation.errors)
      }
      setDerivePreview(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Apply error: ${msg}`)
    } finally {
      setDeriveApplying(false)
    }
  }

  if (scopeLevel !== 'venue') {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-sm text-sage-600">
          Switch to a single venue to edit logistics info.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 flex items-center gap-2 text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    )
  }

  const inputCls =
    'w-full px-3 py-2 border border-sage-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage-300'

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <MapPin className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-bold text-sage-900">
            Venue Info
          </h1>
        </div>
        <p className="text-sm text-sage-600 leading-relaxed">
          What couples and guests see on the &quot;Venue Info&quot; page in
          the portal. Address powers the Google Maps link; parking + entry
          + day-of contact render as separate cards when populated.
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Address</h2>
        <div className="space-y-3">
          <input
            className={inputCls}
            placeholder="Street address"
            value={data.address_line1 ?? ''}
            onChange={(e) => set('address_line1', e.target.value)}
          />
          <div className="grid grid-cols-3 gap-3">
            <input
              className={inputCls}
              placeholder="City"
              value={data.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="State"
              value={data.state ?? ''}
              onChange={(e) => set('state', e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="ZIP"
              value={data.zip ?? ''}
              onChange={(e) => set('zip', e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              className={inputCls}
              placeholder="Latitude (optional)"
              type="number"
              step="any"
              value={data.latitude ?? ''}
              onChange={(e) =>
                set('latitude', e.target.value ? Number(e.target.value) : null)
              }
            />
            <input
              className={inputCls}
              placeholder="Longitude (optional)"
              type="number"
              step="any"
              value={data.longitude ?? ''}
              onChange={(e) =>
                set('longitude', e.target.value ? Number(e.target.value) : null)
              }
            />
          </div>
          <p className="text-xs text-sage-500">
            Lat/lng improve the map pin on phones with weaker geocoding.
            Optional.
          </p>
        </div>
      </section>

      {/* ---------- Wave 8 — external signal codes (auto-derived) ---------- */}
      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-sage-700" />
            <h2 className="font-medium text-sage-900">External signal codes</h2>
          </div>
          <a
            href="/intel/external-signals"
            className="text-xs text-sage-600 hover:text-sage-900 underline"
          >
            View signal health →
          </a>
        </div>
        <p className="text-xs text-sage-500 leading-relaxed mb-4">
          These codes are derived from your address above and gate the
          external-data feeds (Google Trends, NOAA weather, Census, BLS).
          Click <em>Auto-derive from address</em> to fill them in. You can
          override any individual value if you have a more accurate code.
        </p>

        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={handlePreviewDerive}
            disabled={derivePreviewing || deriveApplying}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-60"
          >
            {derivePreviewing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Wand2 className="w-4 h-4" />
            )}
            {derivePreviewing ? 'Deriving…' : 'Auto-derive from address'}
          </button>
          {data.location_derived_at && (
            <span className="text-xs text-sage-500">
              last derived {new Date(data.location_derived_at).toLocaleString()}
            </span>
          )}
        </div>

        {derivePreview && (
          <div className="mb-4 rounded-lg border border-sage-200 bg-sage-50/50 p-4">
            <h3 className="text-sm font-medium text-sage-900 mb-2">
              Preview — what will change
            </h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-sage-500 text-left">
                  <th className="pb-2 pr-3 font-medium">Field</th>
                  <th className="pb-2 pr-3 font-medium">Current</th>
                  <th className="pb-2 pr-3 font-medium">Proposed</th>
                  <th className="pb-2 font-medium">Will write?</th>
                </tr>
              </thead>
              <tbody>
                {derivePreview.map((d) => (
                  <tr key={d.field} className="border-t border-sage-100">
                    <td className="py-1.5 pr-3 font-mono text-sage-700">{d.field}</td>
                    <td className="py-1.5 pr-3 text-sage-600">
                      {d.current == null ? <em className="text-sage-400">empty</em> : String(d.current)}
                    </td>
                    <td className="py-1.5 pr-3 text-sage-900">
                      {d.proposed == null ? <em className="text-sage-400">no match</em> : String(d.proposed)}
                    </td>
                    <td className="py-1.5">
                      {d.willWrite ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <CheckCircle2 className="w-3 h-3" /> yes
                        </span>
                      ) : (
                        <span className="text-sage-400">no</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3">
              <button
                type="button"
                onClick={handleApplyDerive}
                disabled={deriveApplying}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-60"
              >
                {deriveApplying ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                Apply
              </button>
              <button
                type="button"
                onClick={() => setDerivePreview(null)}
                disabled={deriveApplying}
                className="px-3 py-1.5 rounded-lg border border-sage-200 text-xs text-sage-700 hover:bg-sage-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {deriveErrors.length > 0 && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs">
            <div className="flex items-center gap-1 text-amber-800 font-medium mb-1">
              <AlertTriangle className="w-3 h-3" />
              Derivation notes
            </div>
            <ul className="text-amber-700 space-y-0.5 list-disc list-inside">
              {deriveErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Google Trends metro <span className="text-sage-400">(SerpAPI code)</span>
            </label>
            <input
              className={inputCls}
              placeholder="e.g. US-VA-584 or US-VA"
              value={data.google_trends_metro ?? ''}
              onChange={(e) => set('google_trends_metro', e.target.value || null)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              NOAA station ID
            </label>
            <input
              className={inputCls}
              placeholder="e.g. USW00093738"
              value={data.noaa_station_id ?? ''}
              onChange={(e) => set('noaa_station_id', e.target.value || null)}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Google Place ID <span className="text-sage-400">(for review polling)</span>
            </label>
            <input
              className={inputCls}
              placeholder="e.g. ChIJN1t_tDeuEmsRUsoyG83frY4"
              value={data.google_place_id ?? ''}
              onChange={(e) => {
                set('google_place_id', e.target.value || null)
                setPlaceIdTestResult(null)
              }}
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button
                type="button"
                onClick={handleTestPlaceId}
                disabled={placeIdTesting || !data.google_place_id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sage-300 text-xs font-medium text-sage-800 hover:bg-sage-50 disabled:opacity-50"
              >
                {placeIdTesting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3 h-3" />
                )}
                Test
              </button>
              <button
                type="button"
                onClick={handleGooglePullNow}
                disabled={googlePulling || !data.google_place_id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sage-700 text-white text-xs font-medium hover:bg-sage-800 disabled:opacity-50"
              >
                {googlePulling ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Pull reviews now
              </button>
              <a
                href="https://developers.google.com/maps/documentation/places/web-service/place-id"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-sage-600 hover:text-sage-900 underline"
              >
                Place ID Finder ↗
              </a>
            </div>
            {placeIdTestResult ? (
              <div
                className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                  placeIdTestResult.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-rose-200 bg-rose-50 text-rose-800'
                }`}
              >
                {placeIdTestResult.ok ? (
                  <>
                    <div className="font-medium">
                      {placeIdTestResult.name ?? 'Place found'}
                    </div>
                    {placeIdTestResult.address ? (
                      <div className="text-emerald-700">{placeIdTestResult.address}</div>
                    ) : null}
                  </>
                ) : (
                  placeIdTestResult.error
                )}
              </div>
            ) : null}
            {googlePullResult ? (
              <p className="text-xs text-sage-700 mt-2">{googlePullResult}</p>
            ) : null}
            <p className="text-[11px] text-sage-500 mt-2 leading-relaxed">
              Google&apos;s public API returns up to 5 reviews per pull
              (the same 5 most-relevant they show on the listing). Weekly
              cron handles ongoing refresh. For historical backfill, paste
              older reviews on the{' '}
              <a href="/intel/reviews/paste" className="underline hover:text-sage-700">
                Bulk Paste
              </a>{' '}
              page.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Census FIPS <span className="text-sage-400">(county)</span>
            </label>
            <input
              className={inputCls}
              placeholder="e.g. 51047"
              value={data.census_fips ?? ''}
              onChange={(e) => set('census_fips', e.target.value || null)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Metro MSA code <span className="text-sage-400">(BLS)</span>
            </label>
            <input
              className={inputCls}
              placeholder="e.g. 47900"
              value={data.metro_msa_code ?? ''}
              onChange={(e) => set('metro_msa_code', e.target.value || null)}
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-2 pt-1">
            <input
              id="dc-region-proxy"
              type="checkbox"
              checked={data.dc_region_proxy === true}
              onChange={(e) => set('dc_region_proxy', e.target.checked)}
              className="rounded border-sage-300"
            />
            <label htmlFor="dc-region-proxy" className="text-xs text-sage-700">
              DC-region proxy
              <span className="text-sage-400">
                {' '}
                (auto-set by state ∈ {`{VA, DC, MD, WV}`} OR within 100mi of the
                Capitol)
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ---------- TIER 7+ — other review platforms ---------- */}
      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <div className="flex items-center gap-2 mb-2">
          <Star className="w-4 h-4 text-sage-700" />
          <h2 className="font-medium text-sage-900">Other review platforms</h2>
        </div>
        <p className="text-xs text-sage-500 leading-relaxed mb-4">
          Only Google has a public reviews API. For The Knot, WeddingWire,
          Zola, Yelp, and Facebook, paste reviews on the{' '}
          <a href="/intel/reviews/paste" className="underline hover:text-sage-900">
            Bulk Paste
          </a>{' '}
          page. Storing each platform&apos;s URL or business ID here lets
          you and Sage open the live listing in one click from the
          reviews page.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              The Knot listing URL
            </label>
            <input
              className={inputCls}
              placeholder="https://www.theknot.com/marketplace/..."
              value={data.the_knot_url ?? ''}
              onChange={(e) => set('the_knot_url', e.target.value || null)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              WeddingWire listing URL
            </label>
            <input
              className={inputCls}
              placeholder="https://www.weddingwire.com/biz/..."
              value={data.wedding_wire_url ?? ''}
              onChange={(e) => set('wedding_wire_url', e.target.value || null)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Zola listing URL
            </label>
            <input
              className={inputCls}
              placeholder="https://www.zola.com/wedding-vendors/..."
              value={data.zola_url ?? ''}
              onChange={(e) => set('zola_url', e.target.value || null)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Yelp business ID <span className="text-sage-400">(or URL)</span>
            </label>
            <input
              className={inputCls}
              placeholder="rixey-manor-rixeyville"
              value={data.yelp_business_id ?? ''}
              onChange={(e) => set('yelp_business_id', e.target.value || null)}
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-sage-700 mb-1">
              Facebook Page ID <span className="text-sage-400">(or page URL)</span>
            </label>
            <input
              className={inputCls}
              placeholder="rixeymanor or 123456789012345"
              value={data.facebook_page_id ?? ''}
              onChange={(e) => set('facebook_page_id', e.target.value || null)}
            />
          </div>
        </div>
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Parking</h2>
        <textarea
          className={inputCls}
          rows={3}
          placeholder="e.g. Park in the gravel lot to the right of the main gate. Overflow on the grass behind the barn. Valet on Saturday weddings."
          value={data.parking_instructions ?? ''}
          onChange={(e) => set('parking_instructions', e.target.value)}
        />
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Where to enter</h2>
        <textarea
          className={inputCls}
          rows={3}
          placeholder="e.g. Main entrance for couples and guests. Vendors use the rear service road. Accessible entrance is around the side, marked."
          value={data.entry_instructions ?? ''}
          onChange={(e) => set('entry_instructions', e.target.value)}
        />
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-2">A note from the owner</h2>
        <p className="text-xs text-sage-500 mb-4 leading-relaxed">
          Renders as a warm card on the couple dashboard. A short personal
          welcome — what to expect, how often you check in, what they should
          come to you with — goes a long way. The card uses the owner name
          you set on Settings → Personality.
        </p>
        <textarea
          className={inputCls}
          rows={5}
          placeholder="e.g. Hi! I'm Isadora, the owner. I'll be checking in every couple of weeks to see how planning is going. Anything you need that Sage can't help with — just message me directly. We can't wait to host you."
          value={owner.owner_note_to_couples ?? ''}
          onChange={(e) =>
            setOwner({ ...owner, owner_note_to_couples: e.target.value })
          }
        />
        <div className="mt-3">
          <input
            className={inputCls}
            placeholder="Owner photo URL (optional, square-ish recommended)"
            value={owner.owner_photo_url ?? ''}
            onChange={(e) =>
              setOwner({ ...owner, owner_photo_url: e.target.value })
            }
          />
          <p className="text-xs text-sage-500 mt-1">
            Public URL. The card renders text-only when this is blank.
          </p>
        </div>
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Day-of contact</h2>
        <div className="space-y-3">
          <input
            className={inputCls}
            placeholder="Name (e.g. Sarah from Bloom House)"
            value={data.day_of_contact_name ?? ''}
            onChange={(e) => set('day_of_contact_name', e.target.value)}
          />
          <input
            className={inputCls}
            type="tel"
            placeholder="Phone (e.g. +1 555 123 4567)"
            value={data.day_of_contact_phone ?? ''}
            onChange={(e) => set('day_of_contact_phone', e.target.value)}
          />
          <p className="text-xs text-sage-500">
            What couples and vendors see, and what they tap to call on the day.
            Use the venue&apos;s published number, not a personal cell.
          </p>
        </div>
      </section>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : saved ? (
          <Check className="w-4 h-4" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}
