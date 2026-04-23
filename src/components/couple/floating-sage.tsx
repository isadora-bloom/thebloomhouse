'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'

export function FloatingSage({ venueSlug }: { venueSlug: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const { aiName } = useCoupleContext()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  // Don't show on the chat page itself
  const chatPath = `/couple/${venueSlug}/chat`
  if (pathname === chatPath || pathname === chatPath + '/') return null

  async function handleQuickSend() {
    if (!message.trim() || sending) return
    setSending(true)
    // Navigate to chat with the question pre-filled via query param
    const encoded = encodeURIComponent(message.trim())
    router.push(`${chatPath}?q=${encoded}`)
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all no-print',
          'hover:scale-105 active:scale-95',
          open ? 'rotate-0' : 'animate-subtle-bounce'
        )}
        style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
        title={`Ask ${aiName}`}
      >
        {open ? (
          <X className="w-5 h-5 text-white" />
        ) : (
          <MessageCircle className="w-6 h-6 text-white" />
        )}
      </button>

      {/* Quick-ask popup */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden no-print">
          <div
            className="px-4 py-3 text-white"
            style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
          >
            <p className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)' }}>
              Ask {aiName} anything
            </p>
            <p className="text-xs opacity-80 mt-0.5">Your AI planning assistant</p>
          </div>
          <div className="p-4">
            <div className="space-y-2 mb-3">
              {[
                'What should I be working on right now?',
                'Help me with my timeline',
                'What vendors do you recommend?',
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    router.push(`${chatPath}?q=${encodeURIComponent(q)}`)
                  }}
                  className="w-full text-left text-xs px-3 py-2 rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleQuickSend()}
                placeholder="Type a question..."
                className="flex-1 text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--couple-accent)]"
              />
              <button
                onClick={handleQuickSend}
                disabled={!message.trim() || sending}
                className="px-3 py-2 rounded-lg text-white transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes subtle-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        .animate-subtle-bounce {
          animation: subtle-bounce 3s ease-in-out infinite;
        }
      `}</style>
    </>
  )
}
