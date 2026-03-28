'use client'

import { cn } from '@/lib/utils'

interface Tab {
  key: string
  label: string
  count?: number
}

interface TabsProps {
  tabs: Tab[]
  activeTab: string
  onChange: (key: string) => void
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="border-b border-border">
      <nav className="-mb-px flex gap-6" aria-label="Tabs">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
                isActive
                  ? 'border-sage-600 text-sage-900'
                  : 'border-transparent text-muted hover:border-sage-300 hover:text-sage-700'
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
                    isActive
                      ? 'bg-sage-100 text-sage-700'
                      : 'bg-sage-50 text-muted'
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
