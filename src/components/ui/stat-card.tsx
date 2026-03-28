import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string | number
  trend?: { value: number; positive: boolean }
  icon?: LucideIcon
  className?: string
}

export function StatCard({ label, value, trend, icon: Icon, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-sm',
        className
      )}
    >
      <div className="flex items-start justify-between">
        {Icon && (
          <div className="rounded-lg bg-sage-50 p-2">
            <Icon className="h-5 w-5 text-sage-500" />
          </div>
        )}
        {trend && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium',
              trend.positive
                ? 'bg-green-50 text-green-700'
                : 'bg-red-50 text-red-700'
            )}
          >
            {trend.positive ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {Math.abs(trend.value)}%
          </span>
        )}
      </div>
      <div className="mt-3">
        <p className="text-2xl font-bold text-sage-900">{value}</p>
        <p className="mt-0.5 text-sm text-muted">{label}</p>
      </div>
    </div>
  )
}
