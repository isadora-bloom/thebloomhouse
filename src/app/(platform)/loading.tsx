/**
 * Default loading skeleton for the (platform) route group.
 *
 * Lens 1 audit: "Zero loading.tsx files in the entire (platform) tree
 * — every route reimplements its own skeleton." This is the group-
 * level fallback; individual pages can still override with their own
 * loading.tsx for richer per-page skeletons.
 *
 * Intentionally minimal: a centered subtle spinner and "Loading…"
 * text. The shell (sidebar, top bar) renders around this so the
 * coordinator's mental model stays "I'm in Bloom, content is on its
 * way" rather than a blank page.
 */
export default function PlatformLoading() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-sage-200 border-t-sage-600 animate-spin" />
        <p className="text-xs text-sage-500 uppercase tracking-wider">Loading</p>
      </div>
    </div>
  )
}
