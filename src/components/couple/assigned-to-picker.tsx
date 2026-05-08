'use client'

/**
 * Tier-D #191. Replaces window.prompt() in the checklist's
 * assigned_to flow. Two modes:
 *   - chip mode (when value set): click to open editor
 *   - assign mode (when value null): low-opacity affordance to open editor
 *
 * Editor surfaces 8 common defaults (Me / Partner / Mom / Dad / Maid of
 * Honor / Best Man / Coordinator / Custom) so the common case is one
 * click. Custom shows a text input. Esc cancels, Enter or click-out
 * commits.
 */

import { useEffect, useRef, useState } from 'react'
import { Users2, Check, X } from 'lucide-react'

// Round 12 fix #1 (2026-05-08): the click-outside handler used to call
// commit() - but commit() was recreated each render and the effect's
// deps were [open, value], so the registered handler kept a stale
// commit() closure that read the stale draft. User typing in the
// custom input + clicking outside committed an empty string. Fix is
// to keep a ref to the latest commit so the listener always invokes
// the current closure.

const QUICK_PICKS = [
  'Me',
  'Partner',
  'Mom',
  'Dad',
  'Maid of Honor',
  'Best Man',
  'Coordinator',
] as const

interface AssignedToPickerProps {
  value: string | null
  isCompleted?: boolean
  onChange: (next: string | null) => void
}

export function AssignedToPicker({ value, isCompleted, onChange }: AssignedToPickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const ref = useRef<HTMLDivElement>(null)

  // Sync draft to value when the picker is closed. Mid-edit (open=true)
  // we leave the draft alone so an external update from another tab
  // doesn't stomp the user's typing. Worst case: commit overwrites the
  // newer value, which is acceptable for last-write-wins assignment.
  useEffect(() => {
    if (!open) setDraft(value ?? '')
  }, [open, value])

  function commit() {
    const trimmed = draft.trim().slice(0, 80)
    if (trimmed === (value ?? '')) {
      setOpen(false)
      return
    }
    onChange(trimmed || null)
    setOpen(false)
  }

  // Hold a ref to the latest commit so the click-outside handler always
  // reads current state, not the closure from when the listener was
  // registered.
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        commitRef.current()
      }
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDraft(value ?? '')
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('keydown', key)
    }
  }, [open, value])

  function pick(label: string) {
    setDraft(label)
    onChange(label)
    setOpen(false)
  }

  return (
    <div className="relative inline-block" ref={ref}>
      {value ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sage-50 text-sage-700 hover:bg-sage-100"
          title="Click to change"
        >
          <Users2 className="w-3 h-3" />
          {value.length > 24 ? `${value.slice(0, 24)}…` : value}
        </button>
      ) : (
        !isCompleted && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
          >
            <Users2 className="w-3 h-3" />
            Assign
          </button>
        )
      )}

      {open && (
        <div className="absolute z-20 left-0 mt-1 w-56 bg-white border border-border rounded-lg shadow-lg p-2 space-y-1">
          {QUICK_PICKS.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => pick(label)}
              className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-sage-50 text-sage-700 flex items-center justify-between"
            >
              <span>{label}</span>
              {value === label && <Check className="w-3 h-3 text-sage-600" />}
            </button>
          ))}
          <div className="border-t border-border pt-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
              }}
              placeholder="Custom name..."
              maxLength={80}
              autoFocus
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-warm-white"
            />
            <div className="flex items-center justify-between mt-2">
              {value && (
                <button
                  type="button"
                  onClick={() => { onChange(null); setOpen(false) }}
                  className="text-xs text-rose-600 hover:text-rose-800 inline-flex items-center gap-1"
                >
                  <X className="w-3 h-3" />
                  Unassign
                </button>
              )}
              <button
                type="button"
                onClick={commit}
                className="ml-auto px-3 py-1 text-xs bg-sage-600 text-white rounded hover:bg-sage-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
