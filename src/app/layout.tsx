import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'MESI Cache Coherence Simulator',
  description: 'Interactive 2D animation of the MESI cache coherence protocol',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
