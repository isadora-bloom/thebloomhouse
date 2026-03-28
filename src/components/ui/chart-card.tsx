import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface ChartCardProps {
  title: string
  description?: string
  children: ReactNode
  className?: string
}

export function ChartCard({ title, description, children, className }: ChartCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-sm',
        className
      )}
    >
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-sage-900">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        )}
      </div>
      <div>{children}</div>
    </div>
  )
}
