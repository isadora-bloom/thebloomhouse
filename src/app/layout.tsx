import type { Metadata } from 'next'
import { Playfair_Display, Inter } from 'next/font/google'
import './globals.css'

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'The Bloom House',
  description: 'Intelligence-powered wedding venue platform',
  icons: {
    icon: '/favicon.png',
    apple: '/brand/icon-black.png',
  },
  openGraph: {
    title: 'The Bloom House',
    description: 'Intelligence-powered wedding venue platform',
    images: ['/brand/wordmark-black.png'],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable}`}>
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
