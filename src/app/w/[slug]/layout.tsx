import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Wedding Website',
  description: 'You are invited to celebrate with us',
}

export default function WeddingWebsiteLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1">{children}</main>
      <footer className="py-6 text-center">
        <p className="text-[11px] text-gray-300 tracking-wide">
          Powered by{' '}
          <a
            href="https://thebloomhouse.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gray-400 transition-colors"
          >
            Bloom House
          </a>
        </p>
      </footer>
    </div>
  )
}
