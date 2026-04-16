import { Suspense } from 'react'

export default function JoinLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <Suspense>{children}</Suspense>
}
