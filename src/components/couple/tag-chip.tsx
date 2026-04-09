'use client'

import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TagChipData {
  id: string
  name: string
  color: string
}

interface TagChipProps {
  tag: TagChipData
  size?: 'xs' | 'sm'
  onRemove?: () => void
  className?: string
}

/**
 * Small colored pill used to display a guest tag. Supports optional remove
 * button. The text color is always white on the tag background color.
 */
export function TagChip({ tag, size = 'xs', onRemove, className }: TagChipProps) {
  const sizeClasses =
    size === 'sm'
      ? 'px-2 py-0.5 text-[11px]'
      : 'px-1.5 py-0.5 text-[10px]'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium text-white whitespace-nowrap',
        sizeClasses,
        className,
      )}
      style={{ backgroundColor: tag.color }}
    >
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="hover:opacity-75 transition-opacity"
          aria-label={`Remove ${tag.name} tag`}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  )
}
