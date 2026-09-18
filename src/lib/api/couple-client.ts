/**
 * Browser-side calls to /api/couple/[resource].
 *
 * Deliberately shaped like a supabase-js write, `{ data, error }`, so migrating
 * a page is a swap rather than a rewrite:
 *
 *   await supabase.from('wedding_party').insert({ ...fields, wedding_id, venue_id })
 *   await coupleCreate('party', fields)
 *
 * The wedding and venue are gone from the call because the server takes them
 * from the session now. Anything the page still passes for them is refused.
 *
 * Errors come back rather than thrown, for the same reason supabase-js does it:
 * every existing call site already branches on `error`, and a helper that threw
 * would turn a handled save failure into an unhandled rejection in a component.
 */

export interface CoupleWriteResult<T = Record<string, unknown>> {
  data: T | null
  error: { message: string; status?: number } | null
}

async function call<T>(
  resource: string,
  init: RequestInit,
  query = '',
): Promise<CoupleWriteResult<T>> {
  try {
    const res = await fetch(`/api/couple/${resource}${query}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })

    // A 204 or an empty body is a success with nothing to hand back.
    const text = await res.text()
    const body = text ? (JSON.parse(text) as { data?: T; error?: string; ok?: boolean }) : {}

    if (!res.ok) {
      return {
        data: null,
        error: { message: body.error ?? `Could not save (${res.status})`, status: res.status },
      }
    }
    return { data: (body.data ?? null) as T | null, error: null }
  } catch (err) {
    // A network failure, or a body that is not JSON. Either way the save did
    // not happen, and the page needs to be told in the shape it expects.
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : 'Could not reach the server' },
    }
  }
}

/** Add a row. */
export function coupleCreate<T = Record<string, unknown>>(
  resource: string,
  fields: Record<string, unknown>,
) {
  return call<T>(resource, { method: 'POST', body: JSON.stringify(fields) })
}

/** Save a whole-form resource, the one row this wedding has. */
export const coupleSave = coupleCreate

/** Change one row. */
export function coupleUpdate<T = Record<string, unknown>>(
  resource: string,
  id: string,
  fields: Record<string, unknown>,
) {
  return call<T>(resource, { method: 'PATCH', body: JSON.stringify(fields) }, `?id=${encodeURIComponent(id)}`)
}

/** Remove one row. */
export function coupleRemove(resource: string, id: string) {
  return call(resource, { method: 'DELETE' }, `?id=${encodeURIComponent(id)}`)
}

/**
 * Set which tags are on a guest.
 *
 * Its own call rather than part of the generic ones, because
 * guest_tag_assignments has no scope columns and is reached through the guest.
 */
export async function coupleSetGuestTags(guestId: string, tagIds: string[]) {
  return call(`guest-tag-assignments`, { method: 'PUT', body: JSON.stringify({ tagIds }) }, `?guestId=${encodeURIComponent(guestId)}`)
}

/**
 * Replace a whole list in one request, for a resource the page owns entirely.
 */
export function coupleReplaceAll(resource: string, rows: Record<string, unknown>[]) {
  return call(resource, { method: 'PUT', body: JSON.stringify({ rows }) })
}
