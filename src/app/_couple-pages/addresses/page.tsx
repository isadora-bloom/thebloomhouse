'use client'

/**
 * Couple addresses page. B2 starting cut.
 *
 * Lists every people row tied to this wedding that holds an address:
 *   - The couple's own home address (one row each on partner1 / partner2)
 *   - Relative addresses (role='parent' rows the couple types in)
 *
 * The couple can edit / add / remove rows. Coordinator sees a read-only
 * table on /portal/weddings/[id]. Visible only to the couple + venue
 * coordinators per existing wedding-scoped RLS.
 *
 * Privacy posture: every field optional. The couple decides what to
 * share. Bloom uses these for thank-you-card templating, RSVP
 * analytics, and (long-term) identity-graph correlation per the
 * forensic-identity thesis.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { ArrowLeft, Loader2, MapPin, Plus, Pencil, Heart, User } from 'lucide-react'
import { AddressForm, type AddressFormValues } from '@/components/couple/address-form'

interface PersonRow {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  address_label: string | null
  street_line_1: string | null
  street_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
}

function hasAddress(p: PersonRow): boolean {
  return Boolean(p.street_line_1 || p.city || p.postal_code)
}

function formatAddressLines(p: PersonRow): string[] {
  const lines: string[] = []
  if (p.street_line_1) lines.push(p.street_line_1)
  if (p.street_line_2) lines.push(p.street_line_2)
  const cityRegion = [p.city, p.region].filter(Boolean).join(', ')
  if (cityRegion || p.postal_code) {
    lines.push([cityRegion, p.postal_code].filter(Boolean).join(' '))
  }
  if (p.country && p.country.toLowerCase() !== 'usa' && p.country.toLowerCase() !== 'us') {
    lines.push(p.country)
  }
  return lines
}

export default function AddressesPage() {
  const ctx = useCoupleContext()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showNewParent, setShowNewParent] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    if (ctx.loading || !ctx.weddingId) return
    setLoading(true)
    setErr(null)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('people')
      .select('id, role, first_name, last_name, address_label, street_line_1, street_line_2, city, region, postal_code, country')
      .eq('wedding_id', ctx.weddingId)
      .in('role', ['partner1', 'partner2', 'parent'])
      .order('role')
    if (error) {
      setErr(error.message)
    } else {
      setPeople((data ?? []) as PersonRow[])
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.loading, ctx.weddingId])

  async function saveAddress(personId: string, values: AddressFormValues) {
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('people')
      .update({
        street_line_1: values.street_line_1,
        street_line_2: values.street_line_2,
        city: values.city,
        region: values.region,
        postal_code: values.postal_code,
        country: values.country,
        address_label: values.address_label,
      })
      .eq('id', personId)
    setSaving(false)
    if (error) {
      alert(error.message)
      return
    }
    setEditingId(null)
    await load()
  }

  async function createParent(values: AddressFormValues) {
    if (!ctx.weddingId || !ctx.venueId) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('people')
      .insert({
        venue_id: ctx.venueId,
        wedding_id: ctx.weddingId,
        role: 'parent',
        first_name: values.address_label, // mirror label into first_name so it shows in lists
        street_line_1: values.street_line_1,
        street_line_2: values.street_line_2,
        city: values.city,
        region: values.region,
        postal_code: values.postal_code,
        country: values.country,
        address_label: values.address_label,
      })
    setSaving(false)
    if (error) {
      alert(error.message)
      return
    }
    setShowNewParent(false)
    await load()
  }

  async function removeParent(personId: string) {
    if (!confirm('Remove this address?')) return
    const supabase = createClient()
    const { error } = await supabase.from('people').delete().eq('id', personId)
    if (error) {
      alert(error.message)
      return
    }
    await load()
  }

  async function clearCoupleAddress(personId: string) {
    if (!confirm('Clear this address? The person stays; only the address fields are removed.')) return
    const supabase = createClient()
    const { error } = await supabase
      .from('people')
      .update({
        street_line_1: null,
        street_line_2: null,
        city: null,
        region: null,
        postal_code: null,
        country: null,
        address_label: null,
      })
      .eq('id', personId)
    if (error) {
      alert(error.message)
      return
    }
    await load()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          Could not load addresses: {err}
        </div>
      </div>
    )
  }

  const partners = people.filter((p) => p.role === 'partner1' || p.role === 'partner2')
  const parents = people.filter((p) => p.role === 'parent')

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/couple/${ctx.slug}`} className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
            <MapPin className="w-6 h-6 text-teal-600" />
            Addresses
          </h1>
          <p className="text-sm text-sage-500 mt-0.5">
            Your home address and the people in your families. We use this for thank-you cards, hotel block math, and RSVP analytics. Every field is optional.
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-sage-500 flex items-center gap-2">
          <Heart className="w-4 h-4 text-rose-400" />
          You and your partner
        </h2>
        {partners.length === 0 && (
          <p className="text-sm text-sage-500 italic">
            No partner records yet. Add yourself in Wedding Details first.
          </p>
        )}
        {partners.map((p) => {
          const editing = editingId === p.id
          const lines = formatAddressLines(p)
          const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.role === 'partner1' ? 'Partner 1' : 'Partner 2')
          return (
            <div key={p.id}>
              {editing ? (
                <AddressForm
                  initial={p}
                  showLabel={false}
                  saveLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onDelete={hasAddress(p) ? () => clearCoupleAddress(p.id) : undefined}
                  onSave={(v) => saveAddress(p.id, { ...v, address_label: null })}
                  saving={saving}
                />
              ) : (
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-sage-900">{name}</p>
                      {hasAddress(p) ? (
                        <div className="text-sm text-sage-700 mt-1 space-y-0.5">
                          {lines.map((l, i) => <p key={i}>{l}</p>)}
                        </div>
                      ) : (
                        <p className="text-sm text-sage-400 italic mt-1">No address yet</p>
                      )}
                    </div>
                    <button
                      onClick={() => setEditingId(p.id)}
                      className="p-1.5 text-sage-400 hover:text-sage-700 hover:bg-sage-50 rounded"
                      title={hasAddress(p) ? 'Edit' : 'Add address'}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-sage-500 flex items-center gap-2">
          <User className="w-4 h-4 text-sage-500" />
          Family
        </h2>
        {parents.length === 0 && !showNewParent && (
          <p className="text-sm text-sage-500 italic">
            No family addresses yet. Add your parents, in-laws, or anyone whose address you want on file.
          </p>
        )}
        {parents.map((p) => {
          const editing = editingId === p.id
          const lines = formatAddressLines(p)
          const label = p.address_label || p.first_name || 'Family member'
          return (
            <div key={p.id}>
              {editing ? (
                <AddressForm
                  initial={p}
                  saveLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onDelete={() => removeParent(p.id)}
                  onSave={(v) => saveAddress(p.id, v)}
                  saving={saving}
                />
              ) : (
                <div className="bg-surface border border-border rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-sage-900">{label}</p>
                      {hasAddress(p) ? (
                        <div className="text-sm text-sage-700 mt-1 space-y-0.5">
                          {lines.map((l, i) => <p key={i}>{l}</p>)}
                        </div>
                      ) : (
                        <p className="text-sm text-sage-400 italic mt-1">No address yet</p>
                      )}
                    </div>
                    <button
                      onClick={() => setEditingId(p.id)}
                      className="p-1.5 text-sage-400 hover:text-sage-700 hover:bg-sage-50 rounded"
                      title="Edit"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {showNewParent ? (
          <AddressForm
            saveLabel="Add"
            onCancel={() => setShowNewParent(false)}
            onSave={createParent}
            saving={saving}
          />
        ) : (
          <button
            onClick={() => setShowNewParent(true)}
            className="w-full border border-dashed border-border rounded-xl py-3 text-sm text-sage-600 hover:bg-sage-50 inline-flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add a family address
          </button>
        )}
      </section>
    </div>
  )
}
