'use client'

/**
 * Bloom House - Wave 26 hyperlinked body renderer.
 *
 * Renders a plain-text email body with URLs / www. patterns / bare
 * emails turned into clickable <a> tags. Matches the regex used by
 * src/lib/services/draft-learning/plain-to-html.ts so the preview and
 * the actual outgoing HTML stay in lockstep.
 *
 * Links are styled with the sage palette and open in a new tab.
 */

import { detectLinks } from '@/lib/services/draft-learning/plain-to-html'

interface Props {
  body: string
  className?: string
  clamp?: boolean
}

export function HyperlinkedBody({ body, className, clamp }: Props) {
  if (!body) {
    return (
      <p className={className ?? 'text-sm text-sage-700 whitespace-pre-wrap leading-relaxed'}>
        (empty)
      </p>
    )
  }

  const spans = detectLinks(body)
  if (spans.length === 0) {
    return (
      <p
        className={
          className ??
          `text-sm text-sage-700 whitespace-pre-wrap leading-relaxed${clamp ? ' line-clamp-6' : ''}`
        }
      >
        {body}
      </p>
    )
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (span.start > cursor) {
      parts.push(<span key={`t-${i}`}>{body.slice(cursor, span.start)}</span>)
    }
    parts.push(
      <a
        key={`a-${i}`}
        href={span.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sage-700 underline underline-offset-2 hover:text-sage-900"
      >
        {span.display}
      </a>,
    )
    cursor = span.end
  }
  if (cursor < body.length) {
    parts.push(<span key="t-end">{body.slice(cursor)}</span>)
  }

  return (
    <p
      className={
        className ??
        `text-sm text-sage-700 whitespace-pre-wrap leading-relaxed${clamp ? ' line-clamp-6' : ''}`
      }
    >
      {parts}
    </p>
  )
}
