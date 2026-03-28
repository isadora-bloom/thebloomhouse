import type { ReactNode } from 'react'

interface CouplePageWrapperProps {
  title: string
  description?: string
  children: ReactNode
  actions?: ReactNode
}

export function CouplePageWrapper({
  title,
  description,
  children,
  actions,
}: CouplePageWrapperProps) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="text-2xl font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading, var(--font-heading))' }}
          >
            {title}
          </h1>
          {description && (
            <p
              className="mt-1 text-sm opacity-60"
              style={{ fontFamily: 'var(--couple-font-body, var(--font-body))' }}
            >
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  )
}
