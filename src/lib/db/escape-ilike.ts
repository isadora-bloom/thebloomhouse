/**
 * Escaping for user text that ends up inside a PostgREST `.or(...)` filter
 * string.
 *
 * Hoisted out of `src/lib/services/timeline/build-timeline.ts` (2026-09-14
 * security review, item 5), which had the same helper private to itself
 * while `searchKnowledgeBase` interpolated a couple's raw chat message
 * unescaped. Two separate hazards, both reachable from that message:
 *
 *   1. LIKE wildcards. `%` and `_` are wildcards in `ilike`, so a message
 *      containing a bare `%` turns `question.ilike.%foo%` into a pattern
 *      that matches every row. That is silent match-widening, not an
 *      error, which is what makes it worth fixing.
 *   2. The PostgREST filter grammar. The `.or()` argument is a
 *      comma-separated list of `column.op.value` triples, with `(` and
 *      `)` delimiting nested groups and `.` separating the three parts of
 *      a triple. A comma or a bracket inside the value ends the clause
 *      early: at best a 400 back from PostgREST, at worst a filter that
 *      means something other than what was written.
 *
 * The fix is blunt on purpose. Every character that carries meaning in the
 * filter grammar is replaced with a space, because a keyword search does
 * not need to preserve punctuation and a space can never change the shape
 * of the clause. The two LIKE wildcards are then backslash-escaped so they
 * match literally. The grammar pass runs first, which strips any
 * backslash the caller supplied, so the escapes added afterwards are the
 * only backslashes in the result and cannot be doubled up.
 *
 * This is not a general-purpose escaper. It is safe only for the value
 * half of an `ilike` clause.
 */

/** Characters that carry meaning in the PostgREST filter grammar, plus the
 *  braces that delimit an array literal in a `cs.{...}` clause and the
 *  backslash that LIKE uses as its escape character. None of these can be
 *  quoted from inside an unquoted value, so they are replaced. */
const FILTER_GRAMMAR_RE = /[,().'"{}\\]/g

/**
 * Neutralise the filter grammar without touching the LIKE wildcards. Use
 * this for the value of a clause that is not a LIKE — an array literal in
 * `keywords.cs.{...}`, say, where `%` is an ordinary character and a
 * backslash in front of it would be searched for literally.
 */
export function stripFilterGrammar(s: string): string {
  return s.replace(FILTER_GRAMMAR_RE, ' ')
}

/**
 * Make an arbitrary string safe to interpolate as the value of an
 * `ilike` clause inside a PostgREST `.or(...)` string.
 */
export function escapeIlike(s: string): string {
  return stripFilterGrammar(s).replace(/[%_]/g, '\\$&')
}
