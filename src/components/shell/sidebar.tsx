'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  Mail, FileCheck, Kanban, Flame,
  LayoutDashboard, TrendingUp, Users, Newspaper, Star,
  Heart, MessageCircleQuestion, MessagesSquare, BookOpen,
  Settings, Sparkles, Mic, Menu, X,
} from 'lucide-react'

const navSections = [
  {
    title: 'Agent',
    items: [
      { label: 'Inbox', href: '/agent/inbox', icon: Mail },
      { label: 'Drafts', href: '/agent/drafts', icon: FileCheck },
      { label: 'Pipeline', href: '/agent/pipeline', icon: Kanban },
      { label: 'Leads', href: '/agent/leads', icon: Flame },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { label: 'Dashboard', href: '/intel/dashboard', icon: LayoutDashboard },
      { label: 'Sources', href: '/intel/sources', icon: TrendingUp },
      { label: 'Trends', href: '/intel/trends', icon: Sparkles },
      { label: 'Briefings', href: '/intel/briefings', icon: Newspaper },
      { label: 'Reviews', href: '/intel/reviews', icon: Star },
    ],
  },
  {
    title: 'Portal',
    items: [
      { label: 'Weddings', href: '/portal/weddings', icon: Heart },
      { label: 'Sage Queue', href: '/portal/sage-queue', icon: MessageCircleQuestion },
      { label: 'Messages', href: '/portal/messages', icon: MessagesSquare },
      { label: 'Knowledge Base', href: '/portal/kb', icon: BookOpen },
    ],
  },
  {
    title: 'Settings',
    items: [
      { label: 'General', href: '/settings', icon: Settings },
      { label: 'Voice Training', href: '/settings/voice', icon: Mic },
      { label: 'AI Personality', href: '/settings/personality', icon: Sparkles },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  const nav = (
    <nav className="flex flex-col h-full">
      <div className="p-6 border-b border-border">
        <h1 className="font-heading text-xl font-bold text-sage-800">The Bloom House</h1>
      </div>
      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
        {navSections.map((section) => (
          <div key={section.title}>
            <p className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              {section.title}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname.startsWith(item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                        isActive
                          ? 'bg-sage-100 text-sage-800 font-medium'
                          : 'text-sage-600 hover:bg-sage-50 hover:text-sage-800'
                      )}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )

  return (
    <>
      {/* Mobile header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-14 bg-surface border-b border-border z-40 flex items-center px-4">
        <button onClick={() => setMobileOpen(!mobileOpen)} className="p-2 -ml-2">
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <h1 className="font-heading text-lg font-bold text-sage-800 ml-3">The Bloom House</h1>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-14 bottom-0 w-64 bg-surface shadow-xl">
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:block fixed left-0 top-0 bottom-0 w-64 bg-surface border-r border-border z-30">
        {nav}
      </aside>
    </>
  )
}
