'use client'
import { Building2, Layers, MapPin } from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'

export function ScopeIndicator() {
  const scope = useScope()

  const config = scope.level === 'company'
    ? {
        icon: Building2,
        label: 'Viewing all venues',
        name: scope.companyName ?? 'Company',
        bg: 'bg-gold-50 border-gold-200 text-gold-900',
      }
    : scope.level === 'group'
    ? {
        icon: Layers,
        label: 'Viewing group',
        name: scope.groupName ?? 'Group',
        bg: 'bg-teal-50 border-teal-200 text-teal-900',
      }
    : {
        icon: MapPin,
        label: 'Viewing venue',
        name: scope.venueName ?? 'Venue',
        bg: 'bg-sage-50 border-sage-200 text-sage-900',
      }

  const Icon = config.icon

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs ${config.bg}`}>
      <Icon className="w-3.5 h-3.5" />
      <span className="font-medium">{config.label}:</span>
      <span className="font-semibold">{config.name}</span>
    </div>
  )
}
