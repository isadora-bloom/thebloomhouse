'use client'

/**
 * The page a couple lands on from the contract email.
 *
 * It lives under /join because src/middleware.ts already treats that
 * prefix as public, the same way the team-invite landing does, so a
 * token-gated page needs no middleware change to exist. Everything it
 * knows arrives from /api/contracts/sign/[token]: the venue's name, the
 * contract, and whether it has been signed. There is no venue id, no
 * wedding id and no couple record on this page, because the route never
 * sends any.
 *
 * The contract body is HTML the server built by escaping the venue's own
 * plain-text template, which is why dangerouslySetInnerHTML is safe here
 * and would not be if the template were stored as markup.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Check, FileSignature, Loader2, AlertCircle } from 'lucide-react'

interface PublicContract {
  venueName: string
  title: string
  html: string
  signaturePrompt: string
  status: 'draft' | 'sent' | 'viewed' | 'signed' | 'void'
  statusLabel: string
  signedName: string | null
  signedAt: string | null
}

export default function ContractSigningPage() {
  const params = useParams<{ token: string }>()
  const token = typeof params?.token === 'string' ? params.token : ''

  const [contract, setContract] = useState<PublicContract | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typedName, setTypedName] = useState('')
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setError('This link is not valid. Ask the venue to send it again.')
      setLoading(false)
      return
    }
    try {
      const res = await fetch(`/api/contracts/sign/${token}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'This link is not valid.')
      } else {
        setContract(data.contract as PublicContract)
      }
    } catch {
      setError('We could not open that just now. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSign() {
    if (signing) return
    setSigning(true)
    setSignError(null)
    try {
      const res = await fetch(`/api/contracts/sign/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: typedName }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSignError(data?.error ?? 'We could not record that. Try again in a moment.')
      } else {
        setContract(data.contract as PublicContract)
      }
    } catch {
      setSignError('We could not record that. Check your connection and try again.')
    } finally {
      setSigning(false)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#FDFAF6]">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </main>
    )
  }

  if (error || !contract) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#FDFAF6] px-5">
        <div className="max-w-md text-center">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-800 mb-2">
            We could not open that
          </h1>
          <p className="text-sm text-gray-600">{error}</p>
        </div>
      </main>
    )
  }

  const signed = contract.status === 'signed'
  const withdrawn = contract.status === 'void'
  const canSign = !signed && !withdrawn

  return (
    <main className="min-h-screen bg-[#FDFAF6] py-10 px-5">
      <div className="max-w-2xl mx-auto">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
            {contract.venueName}
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold text-gray-900">{contract.title}</h1>
            <span
              className={
                'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ' +
                (signed
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : withdrawn
                    ? 'bg-gray-100 text-gray-600 border-gray-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200')
              }
            >
              {contract.statusLabel}
            </span>
          </div>
        </header>

        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          {/* Server-built markup: the venue's plain-text template, escaped
              on the way out. See renderContractHtml. */}
          <div dangerouslySetInnerHTML={{ __html: contract.html }} />
        </div>

        {withdrawn && (
          <p className="mt-5 text-sm text-gray-600">
            {contract.venueName} has withdrawn this contract. If you were expecting to
            sign something, get in touch with them and they will send a new one.
          </p>
        )}

        {signed && (
          <div className="mt-5 flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-5">
            <Check className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-900">
              <p className="font-medium">
                Signed{contract.signedName ? ` by ${contract.signedName}` : ''}.
              </p>
              <p className="mt-1 text-emerald-800">
                {contract.venueName} has been told. Keep this link; you can come back
                and read the contract whenever you like.
              </p>
            </div>
          </div>
        )}

        {canSign && (
          <div className="mt-5 bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <label
              htmlFor="signed-name"
              className="block text-sm font-medium text-gray-800 mb-2"
            >
              {contract.signaturePrompt}
            </label>
            <input
              id="signed-name"
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Your full name"
              autoComplete="name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
            {signError && (
              <p className="mt-2 text-sm text-red-600">{signError}</p>
            )}
            <button
              type="button"
              onClick={handleSign}
              disabled={signing || typedName.trim().length < 2}
              className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {signing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileSignature className="w-4 h-4" />
              )}
              I agree
            </button>
            <p className="mt-3 text-xs text-gray-500">
              Typing your name here records that you agree to what is written above.
              If anything does not match what you were told, reply to the email
              instead and {contract.venueName} will sort it out.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
