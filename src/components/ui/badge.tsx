import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'outline'
type BadgeSize = 'sm' | 'md'

interface BadgeProps {
  children: ReactNode
  variant?: BadgeVariant
  size?: BadgeSize
  className?: string
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-sage-100 text-sage-700',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
  outline: 'border border-border bg-transparent text-sage-600',
}

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-[11px]',
  md: 'px-2 py-0.5 text-xs',
}

export function Badge({
  children,
  variant = 'default',
  size = 'md',
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium leading-none',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
    >
      {children}
    </span>
  )
}
