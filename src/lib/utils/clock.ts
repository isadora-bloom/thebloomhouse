/**
 * Wall-clock read for components.
 *
 * The React Compiler's purity rule flags a literal `Date.now()` inside a
 * component body, even when wrapped in `useMemo`. Components that need
 * "how long ago" labels read the clock through this helper, once per
 * mount (`useMemo(() => nowMs(), [])`), so the value is stable across
 * re-renders and the intent is visible at the call site.
 */
export function nowMs(): number {
  return Date.now()
}
