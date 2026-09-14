'use client'

/**
 * The couple's contracts page.
 *
 * The list, the search, the upload and the per-contract AI actions all
 * live in src/components/couple/contract-library.tsx now, because the
 * coordinator's wedding page renders the same thing with role
 * "coordinator" (read, search and download, no upload or delete). This
 * page is the couple's half of that: it resolves the couple context and
 * hands the component the wedding id, the venue's assistant name and the
 * two routes only the couple has.
 *
 * Nothing about the couple's experience changed in the move.
 */

import { useRouter } from 'next/navigation'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { ContractLibrary } from '@/components/couple/contract-library'

export default function ContractsPage() {
  const { slug, weddingId, aiName, loading: contextLoading } = useCoupleContext()
  const router = useRouter()

  return (
    <ContractLibrary
      weddingId={weddingId}
      role="couple"
      aiName={aiName}
      contextLoading={contextLoading}
      budgetHref={slug ? `/couple/${slug}/budget` : null}
      onAskAssistant={(contractId) =>
        router.push(`/couple/${slug}/chat?contractId=${contractId}`)
      }
    />
  )
}
