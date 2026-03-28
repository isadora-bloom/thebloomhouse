'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
}: ConfirmDialogProps) {
  const [loading, setLoading] = useState(false)

  if (!isOpen) return null

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <div className="flex items-start gap-4">
          {destructive && (
            <div className="shrink-0 rounded-full bg-red-50 p-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-sage-900">{title}</h3>
            <p className="mt-2 text-sm text-muted">{message}</p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-sage-700 transition-colors hover:bg-sage-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50',
              destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-sage-600 hover:bg-sage-700'
            )}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
