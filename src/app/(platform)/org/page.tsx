'use client'

import Link from 'next/link'
import { GEAR_GROUPS } from '@/components/shell/nav-config'

/**
 * Org admin landing — index for `/org`. Shows the groups of admin
 * surfaces (Team, Billing, Groups, Portfolio analytics, Super admin)
 * with the first item in each group clickable. Role-based filtering
 * is enforced by GearMenu for rail visibility — this index page just
 * renders all groups; the underlying pages themselves check roles.
 */
export default function OrgAdminIndex() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-3xl font-bold text-sage-900">Org admin</h1>
        <p className="text-sage-600 max-w-2xl">
          Team, billing, groups, and portfolio-wide analytics. This is where you manage the
          organisation as a whole. For venue-level Sage configuration, switch to Sage&apos;s Brain.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {GEAR_GROUPS.map((group) => (
          <div key={group.title} className="rounded-xl border border-border bg-surface p-5">
            <h2 className="font-heading text-base font-semibold text-sage-900">{group.title}</h2>
            <ul className="mt-3 space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded text-sm text-sage-700 hover:bg-sage-50 hover:text-sage-900 transition-colors"
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
