'use client'

import { useState, useEffect, type FormEvent } from 'react'
import { cn } from '@/lib/utils'
import { X, Loader2 } from 'lucide-react'

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'time' | 'select' | 'textarea' | 'checkbox' | 'color'
  required?: boolean
  options?: { value: string; label: string }[]
  placeholder?: string
}

interface CrudModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  fields: FieldDef[]
  initialValues?: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>
  submitLabel?: string
  loading?: boolean
}

export function CrudModal({
  isOpen,
  onClose,
  title,
  fields,
  initialValues,
  onSubmit,
  submitLabel = 'Save',
  loading = false,
}: CrudModalProps) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen) {
      const defaults: Record<string, unknown> = {}
      fields.forEach((f) => {
        if (initialValues && initialValues[f.key] !== undefined) {
          defaults[f.key] = initialValues[f.key]
        } else if (f.type === 'checkbox') {
          defaults[f.key] = false
        } else {
          defaults[f.key] = ''
        }
      })
      setValues(defaults)
    }
  }, [isOpen, initialValues, fields])

  if (!isOpen) return null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit(values)
    } finally {
      setSubmitting(false)
    }
  }

  const setValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const isLoading = loading || submitting

  const inputClasses =
    'w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm outline-none transition-colors focus:border-sage-400 focus:ring-1 focus:ring-sage-400 disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-sage-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-sage-50 hover:text-sage-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map((field) => (
            <div key={field.key}>
              {field.type === 'checkbox' ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!values[field.key]}
                    onChange={(e) => setValue(field.key, e.target.checked)}
                    disabled={isLoading}
                    className="h-4 w-4 rounded border-border text-sage-600 focus:ring-sage-400"
                  />
                  <span className="font-medium text-sage-800">{field.label}</span>
                </label>
              ) : (
                <>
                  <label
                    htmlFor={field.key}
                    className="mb-1.5 block text-sm font-medium text-sage-800"
                  >
                    {field.label}
                    {field.required && <span className="ml-0.5 text-red-500">*</span>}
                  </label>

                  {field.type === 'textarea' ? (
                    <textarea
                      id={field.key}
                      value={String(values[field.key] ?? '')}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      required={field.required}
                      disabled={isLoading}
                      rows={3}
                      className={inputClasses}
                    />
                  ) : field.type === 'select' ? (
                    <select
                      id={field.key}
                      value={String(values[field.key] ?? '')}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      required={field.required}
                      disabled={isLoading}
                      className={inputClasses}
                    >
                      <option value="">{field.placeholder ?? 'Select...'}</option>
                      {field.options?.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={field.key}
                      type={field.type}
                      value={String(values[field.key] ?? '')}
                      onChange={(e) =>
                        setValue(
                          field.key,
                          field.type === 'number' ? Number(e.target.value) : e.target.value
                        )
                      }
                      placeholder={field.placeholder}
                      required={field.required}
                      disabled={isLoading}
                      className={cn(
                        inputClasses,
                        field.type === 'color' && 'h-10 cursor-pointer p-1'
                      )}
                    />
                  )}
                </>
              )}
            </div>
          ))}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="rounded-lg px-4 py-2 text-sm font-medium text-sage-700 transition-colors hover:bg-sage-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-sage-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
            >
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
