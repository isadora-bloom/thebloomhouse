'use client'

import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TagChipData } from './tag-chip'

interface TagPickerProps {
  tags: TagChipData[]
  selectedIds: string[]
  onToggle: (tagId: string) => void
  onClose?: () => void
  anchorClassName?: string
  className?: string
  title?: string
}

/**
 * Small popover that lists all tags with checkboxes. Consumer supplies
 * selection state and receives toggle callbacks. Closes when clicking
 * outside (via onClose) if provided.
 */
export function TagPicker({
  tags,
  selectedIds,
  onToggle,
  onClose,
  className,
  title = 'Assign tags',
}: TagPickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!onClose) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose?.()
      }
    }
    // Defer so the mount click doesn't immediately close
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className={cn(
        'z-50 w-56 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden',
        className,
      )}
    >
      <div className="px-3 py-2 border-b border-gray-100 text-[11px] font-medium text-gray-500 uppercase tracking-wide">
        {title}
      </div>
      {tags.length === 0 ? (
        <div className="px-3 py-4 text-xs text-gray-400 text-center">
          No tags yet. Create one from the guest list settings.
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1">
          {tags.map((tag) => {
            const selected = selectedIds.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(tag.id)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 transition-colors"
              >
                <span
                  className={cn(
                    'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                    selected ? 'border-transparent' : 'border-gray-300',
                  )}
                  style={selected ? { backgroundColor: tag.color } : undefined}
                >
                  {selected && <Check className="w-3 h-3 text-white" />}
                </span>
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="text-xs text-gray-700 flex-1 truncate">{tag.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
