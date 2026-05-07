import Link from 'next/link'
import { Mail } from 'lucide-react'

/**
 * /contact — sales-led entry point.
 *
 * Used by the pricing page for tiers that don't go through Stripe checkout
 * (Pre-Opening, Multi, Enterprise per src/lib/billing/plans.ts contactSales).
 *
 * Round-5 audit caught this route as missing — the pricing page was sending
 * 60% of plans to a 404. This is the minimum viable replacement: a page
 * that's a no-op besides a single mailto link, but at least the URL
 * resolves and the user knows where to go. A real form (subject routing,
 * reCAPTCHA, lead-stage tagging) lands in a follow-up.
 */
export default function ContactPage() {
  return (
    <div className="min-h-screen bg-warm-white">
      <header className="border-b border-sage-100">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img src="/brand/wordmark-sage.png" alt="The Bloom House" className="h-7 w-auto" />
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/pricing" className="text-sage-700 hover:text-sage-900">
              Pricing
            </Link>
            <Link
              href="/login"
              className="px-4 py-2 rounded-lg bg-sage-600 text-white hover:bg-sage-700 transition-colors"
            >
              Log in
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <h1 className="font-heading text-4xl md:text-5xl font-bold text-sage-900 mb-6">
          Let&apos;s talk
        </h1>
        <p className="text-lg text-sage-600 mb-10 leading-relaxed">
          Pre-Opening, Multi, and Enterprise plans are sales-led so we can
          tailor the rollout to your team. Tell us about your venue and
          we&apos;ll get back to you within one business day.
        </p>

        <a
          href="mailto:hello@thebloomhouse.ai?subject=Bloom%20House%20enquiry"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 transition-colors"
        >
          <Mail className="w-4 h-4" />
          hello@thebloomhouse.ai
        </a>

        <p className="mt-12 text-sm text-sage-500">
          Already a customer?{' '}
          <Link href="/login" className="text-sage-700 underline">
            Log in
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
