import { cn } from '@/lib/utils'

export function CommunicationPulse({ messageCount }: { messageCount: number }) {
  let label: string
  let bgClass: string
  let textClass: string
  let dotClass: string

  if (messageCount <= 2) {
    label = 'Quiet'
    bgClass = 'bg-amber-50'
    textClass = 'text-amber-700'
    dotClass = 'bg-amber-400'
  } else if (messageCount <= 8) {
    label = 'Typical'
    bgClass = 'bg-sage-50'
    textClass = 'text-sage-700'
    dotClass = 'bg-sage-500'
  } else {
    label = 'Active'
    bgClass = 'bg-emerald-50'
    textClass = 'text-emerald-700'
    dotClass = 'bg-emerald-500'
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium', bgClass, textClass)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', dotClass)} />
      {label}
    </span>
  )
}
