/**
 * Default loading skeleton for the couple portal route segment.
 *
 * Sarah's audit said the dashboard already feels empty for new
 * couples — we don't want a flash-of-blank-page on top of that.
 * Per-couple-portal-page loading.tsx files can still override with
 * richer per-page skeletons (the existing `if (loading) ...` blocks
 * in each page render the per-page UI).
 */
export default function CoupleLoading() {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="flex flex-col items-center gap-3">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{
            borderColor: 'rgba(166, 137, 74, 0.2)',
            borderTopColor: 'var(--couple-primary, #A6894A)',
          }}
        />
        <p className="text-xs text-gray-400 tracking-wider">Loading</p>
      </div>
    </div>
  )
}
