/**
 * Shown to couples when their venue's account is frozen (trial ended with
 * no subscription, migration 417). Couples aren't told why: the venue's
 * billing is between the venue and Bloom. They're told what it means for
 * them and who to contact.
 */
export function PortalReadOnlyNotice({ venueName }: { venueName: string }) {
  return (
    <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="font-medium">Your planning portal is read-only for now</div>
      <div className="mt-0.5">
        Everything you&apos;ve added is safe and you can still see it, but changes can&apos;t be saved at the moment. If
        you need something, please contact {venueName} directly.
      </div>
    </div>
  )
}
