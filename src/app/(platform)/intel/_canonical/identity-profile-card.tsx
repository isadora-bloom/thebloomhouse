'use client'

/**
 * The forensic identity profile, rendered for the first time.
 *
 * This card existed on /intel/couples/[id] and had never once drawn a
 * value. Two reasons, both fixed now:
 *
 *   - the query asked couple_identity_profile for `couple_id`, but the
 *     table is keyed on `wedding_id` (migration 260), so PostgREST
 *     answered 400 and the card fell through its own null check;
 *   - the page's type expected flat columns, while the row holds one
 *     `profile` jsonb of nested claims with evidence quotes.
 *
 * getCoupleJourney does the wedding_id lookup properly, via
 * couples.source_wedding_id, and buildIdentityProfileView parses the
 * jsonb. What arrives here is already shaped.
 *
 * Rendering rule: every claim shows its evidence quote when the model
 * gave one. That is the whole point of a forensic reconstruction — a
 * claim with no quote behind it is a guess, and the operator should be
 * able to tell the difference at a glance.
 */

import { Quote, Sparkles } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { WhyThisCard } from '@/components/ui/why-this-card'
import {
  buildIdentityProfileView,
  type ProfileClaimView,
  type ProfileNameView,
} from '@/lib/intel/adapters/identity-profile-view'

function NameBlock({ label, view }: { label: string; view: ProfileNameView }) {
  return (
    <div>
      <span className="text-xs uppercase tracking-wide text-stone-500">{label}</span>
      <div className="text-stone-800">
        {view.name}
        {view.occupation ? (
          <span className="text-stone-500"> · {view.occupation}</span>
        ) : null}
        {view.confidence !== null ? (
          <span className="ml-2 text-xs text-stone-400">
            {view.confidence}% confident
          </span>
        ) : null}
      </div>
      {view.evidenceQuote ? (
        <p className="mt-0.5 flex gap-1 text-xs italic text-stone-500">
          <Quote className="mt-0.5 h-3 w-3 shrink-0" />
          {view.evidenceQuote}
        </p>
      ) : null}
    </div>
  )
}

function ClaimList({ title, claims }: { title: string; claims: ProfileClaimView[] }) {
  const visible = claims.filter((c) => !c.sensitive)
  const sensitiveCount = claims.length - visible.length
  if (claims.length === 0) return null
  return (
    <div className="col-span-2">
      <span className="text-xs uppercase tracking-wide text-stone-500">{title}</span>
      <ul className="mt-1 space-y-1">
        {visible.map((c, i) => (
          <li key={`${c.label}-${i}`} className="text-sm text-stone-700">
            <span className="font-medium">{c.label}</span>
            {c.detail ? <span className="text-stone-600"> — {c.detail}</span> : null}
            {c.evidenceQuote ? (
              <span className="block text-xs italic text-stone-500">
                &ldquo;{c.evidenceQuote}&rdquo;
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {sensitiveCount > 0 ? (
        <p className="mt-1 text-xs text-stone-400">
          {sensitiveCount} further {sensitiveCount === 1 ? 'claim is' : 'claims are'}{' '}
          marked sensitive and held back from this summary.
        </p>
      ) : null}
    </div>
  )
}

export function IdentityProfileCard({
  profile,
  hasSourceWedding,
}: {
  profile: Record<string, unknown> | null
  /** False when the couple has never been mirrored to a wedding, which
   *  is why the profile is absent — a different story from "we looked
   *  and found nothing". */
  hasSourceWedding: boolean
}) {
  const view = buildIdentityProfileView(profile)

  if (!view.hasContent) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No reconstructed profile yet"
        subtitle={
          hasSourceWedding
            ? 'The forensic reconstruction has not run for this couple, or it ran and refused every field for lack of evidence. Either way there is nothing here to show, which is the honest answer.'
            : 'This couple has no mirrored wedding record, and the reconstruction is keyed on one. Nothing has been attempted for them yet.'
        }
        variant="dashed"
        className="mb-8"
      />
    )
  }

  return (
    <div className="mb-8 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-700" />
        <h2 className="text-sm font-semibold text-violet-900">Identity profile</h2>
        {view.nameQuality ? (
          <span className="rounded-full border border-violet-200 bg-white px-2 py-0.5 text-xs text-violet-800">
            name evidence: {view.nameQuality}
          </span>
        ) : null}
        {view.phantomPartner ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
            partner referred to but never named
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        {view.partner1 ? <NameBlock label="Partner 1" view={view.partner1} /> : null}
        {view.partner2 ? <NameBlock label="Partner 2" view={view.partner2} /> : null}
        {view.residence ? (
          <div>
            <span className="text-xs uppercase tracking-wide text-stone-500">
              Lives
            </span>
            <div className="text-stone-800">{view.residence}</div>
            {view.residenceQuote ? (
              <p className="mt-0.5 text-xs italic text-stone-500">
                &ldquo;{view.residenceQuote}&rdquo;
              </p>
            ) : null}
          </div>
        ) : null}
        <ClaimList title="What matters to them" claims={view.emotionalTruths} />
        <ClaimList title="Family" claims={view.familyDynamics} />
        <ClaimList title="Cultural signals" claims={view.culturalSignals} />
        <ClaimList title="Access needs" claims={view.accessibilityNeeds} />
        <ClaimList title="Handles" claims={view.handles} />
      </div>

      {view.refusals.length > 0 ? (
        <div className="mt-3 border-t border-violet-200 pt-2">
          <p className="text-xs uppercase tracking-wide text-stone-500">
            Deliberately not answered
          </p>
          <ul className="mt-1 space-y-0.5">
            {view.refusals.map((r) => (
              <li key={r.field} className="text-xs text-stone-600">
                <span className="font-medium">{r.field}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <WhyThisCard
        title="Where this profile comes from"
        reasoning="Reconstructed from this couple's own words across every channel, then stored once and read from storage. Nothing here is re-extracted at render time, and every populated claim carries the verbatim quote it was taken from."
        evidence={[
          'Read through getCoupleJourney, which resolves the profile by wedding id via couples.source_wedding_id.',
          'A refusal is information: the model was asked and declined for want of evidence.',
          'Claims marked sensitive are held back from this summary by design.',
        ]}
        source="couple_identity_profile.profile (migration 260)"
      />
    </div>
  )
}
