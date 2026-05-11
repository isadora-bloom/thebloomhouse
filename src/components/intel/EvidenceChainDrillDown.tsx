'use client'

/**
 * Wave 24 — evidence-chain drill-down panel.
 *
 * Renders the list of weddings that contributed to a Channel Truth
 * answer's cells, plus the reproducibility footer (compute_signature +
 * computed_at_iso + prompt versions used).
 *
 * Used inside ChannelTruthAnswer. Stays presentational — all data comes
 * from the parent.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FileCode } from 'lucide-react'
import type { EvidenceWedding } from '@/lib/services/channel-truth/types'

interface Props {
  weddings: EvidenceWedding[]
  computeSignature: string
  computedAtIso: string
  promptVersionsUsed: string[]
  contextNotes: string[]
}

export function EvidenceChainDrillDown(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3 border border-stone-200 rounded-md bg-stone-50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center gap-2 text-sm font-medium text-stone-700 hover:bg-stone-100 rounded-md"
      >
        {open ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        Expand evidence ({props.weddings.length} weddings)
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-stone-200">
          {props.contextNotes.length > 0 && (
            <div className="mb-3 text-xs text-stone-600 space-y-1">
              {props.contextNotes.map((n, i) => (
                <div key={i}>• {n}</div>
              ))}
            </div>
          )}
          {props.weddings.length === 0 ? (
            <div className="text-xs text-stone-500 italic py-2">
              No underlying weddings to show.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-stone-100 text-stone-600 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Wedding</th>
                    <th className="px-2 py-1 text-left">Annotation</th>
                    <th className="px-2 py-1 text-left">Platform</th>
                    <th className="px-2 py-1 text-left">Intent</th>
                    <th className="px-2 py-1 text-left">v1?</th>
                  </tr>
                </thead>
                <tbody>
                  {props.weddings.map((w) => (
                    <tr
                      key={w.wedding_id}
                      className="border-t border-stone-200"
                    >
                      <td className="px-2 py-1 font-mono text-stone-700">
                        {w.display_label}
                      </td>
                      <td className="px-2 py-1 text-stone-600">{w.annotation}</td>
                      <td className="px-2 py-1 text-stone-600">
                        {w.source_platform ?? '—'}
                      </td>
                      <td className="px-2 py-1 text-stone-600">
                        {w.intent_class ?? '—'}
                      </td>
                      <td className="px-2 py-1">
                        {w.v1_contaminated ? (
                          <span className="text-amber-700 font-semibold">v1*</span>
                        ) : (
                          <span className="text-stone-400">v2</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 pt-2 border-t border-stone-200">
            <div className="flex items-start gap-2 text-xs text-stone-500">
              <FileCode className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <div>
                <div>
                  <span className="font-medium text-stone-700">Reproducibility:</span>{' '}
                  <span className="font-mono">{props.computeSignature}</span>
                </div>
                <div>Computed at {new Date(props.computedAtIso).toLocaleString()}</div>
                {props.promptVersionsUsed.length > 0 && (
                  <div>
                    Prompt versions in evidence:{' '}
                    {props.promptVersionsUsed.map((pv) => (
                      <span
                        key={pv}
                        className={`inline-block px-1.5 py-0.5 mx-0.5 rounded font-mono text-[10px] ${
                          pv.endsWith('.v1')
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {pv}
                      </span>
                    ))}
                  </div>
                )}
                <a
                  href={`https://github.com/isadora-bloom/thebloomhouse/blob/master/src/lib/services/channel-truth/answer/`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-stone-600 hover:text-stone-900 mt-1"
                >
                  View source <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
