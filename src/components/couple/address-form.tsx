'use client'

/**
 * Reusable address form. B2 starting cut.
 *
 * Used by /couple/[slug]/addresses for both the couple's own address
 * (locked role/label - editing the partner1 / partner2 row) and the
 * "Add a relative" row (role='parent' with couple-typed label).
 *
 * Address fields are optional individually. Save is enabled if at
 * least street_line_1 OR city OR postal_code is filled.
 */

import { useState, useEffect } from 'react'
import { Save, X, Trash2 } from 'lucide-react'

export interface AddressFormValues {
  street_line_1: string | null
  street_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  address_label: string | null
}

interface AddressFormProps {
  /** Initial values when editing; empty for a new row. */
  initial?: Partial<AddressFormValues>
  /** When true, renders the label input. False for partner1/partner2 fixed-role rows. */
  showLabel?: boolean
  /** Submit handler. Called only when at least one address field is non-empty. */
  onSave: (values: AddressFormValues) => Promise<void> | void
  /** Optional cancel callback (closes the form). */
  onCancel?: () => void
  /** Optional delete callback (only renders when present). */
  onDelete?: () => Promise<void> | void
  /** Save button label override. */
  saveLabel?: string
  /** Whether the save action is in flight. */
  saving?: boolean
}

export function AddressForm({
  initial,
  showLabel = true,
  onSave,
  onCancel,
  onDelete,
  saveLabel = 'Save address',
  saving = false,
}: AddressFormProps) {
  const [streetLine1, setStreetLine1] = useState('')
  const [streetLine2, setStreetLine2] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('')
  const [label, setLabel] = useState('')

  useEffect(() => {
    setStreetLine1(initial?.street_line_1 ?? '')
    setStreetLine2(initial?.street_line_2 ?? '')
    setCity(initial?.city ?? '')
    setRegion(initial?.region ?? '')
    setPostalCode(initial?.postal_code ?? '')
    setCountry(initial?.country ?? '')
    setLabel(initial?.address_label ?? '')
  }, [initial])

  const canSave =
    streetLine1.trim().length > 0 ||
    city.trim().length > 0 ||
    postalCode.trim().length > 0

  async function handleSave() {
    if (!canSave) return
    await onSave({
      street_line_1: streetLine1.trim() || null,
      street_line_2: streetLine2.trim() || null,
      city: city.trim() || null,
      region: region.trim() || null,
      postal_code: postalCode.trim() || null,
      country: country.trim() || null,
      address_label: showLabel ? (label.trim() || null) : null,
    })
  }

  return (
    <div className="bg-warm-white border border-border rounded-xl p-4 space-y-3">
      {showLabel && (
        <div>
          <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">
            Whose address is this?
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. My mom, Joel's dad and step-mom"
            maxLength={120}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white"
          />
        </div>
      )}

      <div>
        <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">
          Street
        </label>
        <input
          type="text"
          value={streetLine1}
          onChange={(e) => setStreetLine1(e.target.value)}
          placeholder="Street address"
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
      </div>

      <div>
        <input
          type="text"
          value={streetLine2}
          onChange={(e) => setStreetLine2(e.target.value)}
          placeholder="Apt, suite, etc. (optional)"
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="City"
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
        <input
          type="text"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="State / region"
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
          placeholder="ZIP / postal code"
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
        <input
          type="text"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="Country (USA if blank)"
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white"
        />
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-rose-600 hover:text-rose-800 inline-flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            Remove
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs text-sage-600 hover:text-sage-900 inline-flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || saving}
            className="px-4 py-1.5 text-xs bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving...' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
