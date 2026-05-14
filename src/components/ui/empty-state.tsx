import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shared empty-state. Three variants by the props you pass:
 *   - compact: icon + text only (use `text`)
 *   - standard: icon + title + subtitle
 *   - with CTA: add an `action` prop pointing to where the operator should go
 *
 * Coordinator-facing empty states should always tell the operator what
 * to do next. "Nothing here" alone is a dead end; "Nothing here. Try X"
 * is a guide.
 */
interface EmptyStateProps {
  icon?: LucideIcon
  title?: string
  subtitle?: string
  text?: string
  action?: {
    label: string
    href?: string
    onClick?: () => void
  }
  variant?: 'card' | 'dashed' | 'inline'
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  text,
  action,
  variant = 'card',
  className,
}: EmptyStateProps) {
  const isCompact = !title && (text || subtitle)
  const body = text ?? subtitle
  const containerClass = cn(
    'text-center',
    variant === 'card' && 'bg-surface border border-border rounded-xl shadow-sm',
    variant === 'dashed' && 'border border-dashed border-border rounded-lg bg-warm-white',
    variant === 'inline' && '',
    isCompact ? 'p-8' : 'p-10',
    className
  )

  const ActionEl = action ? (
    action.href ? (
      <Link
        href={action.href}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-sage-700 px-4 py-2 text-sm text-white hover:bg-sage-800 transition-colors"
      >
        {action.label}
      </Link>
    ) : (
      <button
        type="button"
        onClick={action.onClick}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-sage-700 px-4 py-2 text-sm text-white hover:bg-sage-800 transition-colors"
      >
        {action.label}
      </button>
    )
  ) : null

  if (isCompact) {
    return (
      <div className={containerClass}>
        {Icon ? <Icon className="w-10 h-10 text-sage-300 mx-auto mb-3" /> : null}
        <p className="text-sm text-sage-600">{body}</p>
        {ActionEl}
      </div>
    )
  }

  return (
    <div className={containerClass}>
      {Icon ? <Icon className="w-12 h-12 text-sage-300 mx-auto mb-4" /> : null}
      {title ? (
        <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">{title}</h3>
      ) : null}
      {body ? (
        <p className="text-sm text-sage-600 max-w-md mx-auto">{body}</p>
      ) : null}
      {ActionEl}
    </div>
  )
}
