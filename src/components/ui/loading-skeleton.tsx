import { cn } from '@/lib/utils'

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-lg bg-sage-100', className)}
    />
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Bone className="h-7 w-48" />
          <Bone className="h-4 w-72" />
        </div>
        <Bone className="h-9 w-28 rounded-lg" />
      </div>
      {/* Body placeholder */}
      <div className="space-y-4">
        <Bone className="h-40 w-full rounded-xl" />
        <Bone className="h-64 w-full rounded-xl" />
      </div>
    </div>
  )
}

export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-surface p-5 shadow-sm"
        >
          <div className="flex items-start justify-between">
            <Bone className="h-9 w-9 rounded-lg" />
            <Bone className="h-5 w-14 rounded-full" />
          </div>
          <div className="mt-3 space-y-2">
            <Bone className="h-7 w-20" />
            <Bone className="h-4 w-28" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm">
      {/* Search bar */}
      <div className="border-b border-border p-3">
        <Bone className="h-9 w-64 rounded-lg" />
      </div>
      {/* Header row */}
      <div className="flex gap-4 border-b border-border bg-sage-50/50 px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Bone key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }).map((_, ri) => (
        <div
          key={ri}
          className="flex gap-4 border-b border-border px-4 py-3 last:border-0"
        >
          {Array.from({ length: columns }).map((_, ci) => (
            <Bone key={ci} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-surface p-5 shadow-sm"
        >
          <div className="space-y-3">
            <Bone className="h-5 w-3/4" />
            <Bone className="h-4 w-full" />
            <Bone className="h-4 w-5/6" />
          </div>
          <div className="mt-4 flex gap-2">
            <Bone className="h-6 w-16 rounded-full" />
            <Bone className="h-6 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
