import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && (
        <div className="mb-4 rounded-full bg-sage-50 p-4">
          <Icon className="h-8 w-8 text-muted" />
        </div>
      )}
      <h3 className="text-base font-semibold text-sage-800">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 rounded-lg bg-sage-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sage-700"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
