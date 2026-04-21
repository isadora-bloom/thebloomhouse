'use client'

// Feature: Ceremony chair plan — visual X layout with rows
// Table: ceremony_chair_plans (wedding_id UNIQUE, plan JSONB)

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { Plus, Trash2, Save, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ChairRow {
  left: number
  right: number
  label: string
}

interface ChairPlan {
  rows: ChairRow[]
}

const DEFAULT_SIDES = 6

export default function CeremonyChairsPage() {
  const { weddingId } = useCoupleContext()
  const supabase = createClient()

  const [rows, setRows] = useState<ChairRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (weddingId) load()
  }, [weddingId])

  const load = async () => {
    const { data } = await supabase
      .from('ceremony_chair_plans')
      .select('plan')
      .eq('wedding_id', weddingId!)
      .maybeSingle()
    if (data?.plan?.rows?.length) setRows(data.plan.rows)
    setLoading(false)
  }

  const save = async (newRows?: ChairRow[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaved(false)
    setSaving(true)
    const plan: ChairPlan = { rows: newRows ?? rows }
    await supabase.from('ceremony_chair_plans').upsert(
      { wedding_id: weddingId!, plan, updated_at: new Date().toISOString() },
      { onConflict: 'wedding_id' }
    )
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const autoSave = (newRows: ChairRow[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => save(newRows), 1200)
  }

  const updateRow = (idx: number, field: 'left' | 'right', value: number) => {
    const next = rows.map((r, i) => i === idx ? { ...r, [field]: Math.max(0, value) } : r)
    setRows(next)
    autoSave(next)
  }

  const updateRowLabel = (idx: number, label: string) => {
    const next = rows.map((r, i) => i === idx ? { ...r, label } : r)
    setRows(next)
    autoSave(next)
  }

  const addRow = () => {
    const last = rows[rows.length - 1]
    const next = [...rows, { left: last?.left ?? DEFAULT_SIDES, right: last?.right ?? DEFAULT_SIDES, label: '' }]
    setRows(next)
    autoSave(next)
  }

  const addMultipleRows = (count: number) => {
    const last = rows[rows.length - 1]
    const newRows = Array.from({ length: count }, () => ({
      left: last?.left ?? DEFAULT_SIDES,
      right: last?.right ?? DEFAULT_SIDES,
      label: '',
    }))
    const next = [...rows, ...newRows]
    setRows(next)
    autoSave(next)
  }

  const removeRow = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx)
    setRows(next)
    autoSave(next)
  }

  const totalSeats = rows.reduce((sum, r) => sum + (r.left || 0) + (r.right || 0), 0)
  const totalLeft = rows.reduce((sum, r) => sum + (r.left || 0), 0)
  const totalRight = rows.reduce((sum, r) => sum + (r.right || 0), 0)
  const maxSide = Math.max(...rows.map(r => Math.max(r.left || 0, r.right || 0)), 1)

  if (loading) return <div className="text-muted-foreground text-center py-8">Loading ceremony plan...</div>

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ceremony Chair Plan</h1>
          <p className="text-sm text-muted-foreground">Visual seating layout for the ceremony</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {saving && 'Saving...'}
          {saved && <span className="text-green-600 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
        </div>
      </div>

      {/* Totals */}
      <div className="bg-primary text-primary-foreground rounded-xl p-4">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold">{totalLeft}</p>
            <p className="text-sm opacity-80">Left side</p>
          </div>
          <div>
            <p className="text-3xl font-bold">{totalSeats}</p>
            <p className="text-sm opacity-80">Total chairs</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{totalRight}</p>
            <p className="text-sm opacity-80">Right side</p>
          </div>
        </div>
        <p className="text-xs text-center mt-2 opacity-70">{rows.length} row{rows.length !== 1 ? 's' : ''}</p>
      </div>

      {/* Visual layout */}
      <div className="bg-muted/30 border rounded-xl p-4 sm:p-6 overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">
            No rows yet. Add rows below to build your ceremony layout.
          </p>
        ) : (
          <div className="space-y-1 min-w-fit">
            <div className="text-center mb-4">
              <div className="inline-block px-6 py-2 bg-muted border rounded-lg">
                <span className="text-sm font-medium">Altar / Officiant</span>
              </div>
            </div>

            {rows.map((row, idx) => (
              <div key={idx} className="flex items-center justify-center gap-1 group">
                <span className="text-xs text-muted-foreground w-8 text-right flex-shrink-0 tabular-nums">
                  R{idx + 1}
                </span>
                <div className="flex justify-end gap-0.5 flex-shrink-0" style={{ width: `${maxSide * 1.25}rem` }}>
                  {Array.from({ length: row.left || 0 }).map((_, i) => (
                    <span key={i} className="w-4 h-4 flex items-center justify-center text-foreground text-xs font-bold select-none">X</span>
                  ))}
                </div>
                <span className="text-xs font-bold w-6 text-center flex-shrink-0 tabular-nums">{row.left || 0}</span>
                <div className="w-12 sm:w-16 flex-shrink-0 border-l border-r border-dashed border-muted-foreground/30 mx-1" />
                <span className="text-xs font-bold w-6 text-center flex-shrink-0 tabular-nums">{row.right || 0}</span>
                <div className="flex justify-start gap-0.5 flex-shrink-0" style={{ width: `${maxSide * 1.25}rem` }}>
                  {Array.from({ length: row.right || 0 }).map((_, i) => (
                    <span key={i} className="w-4 h-4 flex items-center justify-center text-foreground text-xs font-bold select-none">X</span>
                  ))}
                </div>
                {row.label && <span className="text-xs text-muted-foreground ml-2 flex-shrink-0">{row.label}</span>}
                <span className="text-xs text-muted-foreground ml-2 flex-shrink-0 tabular-nums">= {(row.left || 0) + (row.right || 0)}</span>
              </div>
            ))}

            <div className="text-center mt-4 pt-2 border-t border-dashed">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Back of ceremony</span>
            </div>
          </div>
        )}
      </div>

      {/* Row editor */}
      <div className="border rounded-xl overflow-hidden">
        <div className="bg-muted/50 px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-medium text-sm">Edit Rows</h3>
          <div className="flex gap-2">
            <button onClick={addRow}
              className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add Row
            </button>
            <button onClick={() => addMultipleRows(5)}
              className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
              + 5 Rows
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-muted-foreground text-sm mb-3">Start by adding rows for your ceremony seating.</p>
            <div className="flex gap-2 justify-center flex-wrap">
              <button onClick={() => {
                const starter: ChairRow[] = Array.from({ length: 7 }, (_, i) => ({
                  left: i === 0 ? 4 : 6, right: i === 0 ? 4 : 6, label: i === 0 ? 'Reserved' : '',
                }))
                setRows(starter)
                autoSave(starter)
              }}
                className="px-4 py-2 rounded-lg border text-sm hover:bg-muted/50 transition">
                Quick start: 7 rows (48 chairs)
              </button>
              <button onClick={() => {
                const starter: ChairRow[] = Array.from({ length: 10 }, (_, i) => ({
                  left: i < 2 ? 5 : 8, right: i < 2 ? 5 : 8, label: i === 0 ? 'Reserved' : '',
                }))
                setRows(starter)
                autoSave(starter)
              }}
                className="px-4 py-2 rounded-lg border text-sm hover:bg-muted/50 transition">
                Quick start: 10 rows (140 chairs)
              </button>
            </div>
          </div>
        ) : (
          <div className="divide-y max-h-96 overflow-y-auto">
            {rows.map((row, idx) => (
              <div key={idx} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-xs font-medium text-muted-foreground w-8 flex-shrink-0">R{idx + 1}</span>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-muted-foreground">L</label>
                  <input type="number" min={0} max={30} value={row.left}
                    onChange={e => updateRow(idx, 'left', parseInt(e.target.value) || 0)}
                    className="w-14 px-2 py-1.5 border rounded-lg text-sm text-center focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-muted-foreground">R</label>
                  <input type="number" min={0} max={30} value={row.right}
                    onChange={e => updateRow(idx, 'right', parseInt(e.target.value) || 0)}
                    className="w-14 px-2 py-1.5 border rounded-lg text-sm text-center focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <input type="text" value={row.label || ''} onChange={e => updateRowLabel(idx, e.target.value)}
                  placeholder="Label (optional)"
                  className="flex-1 px-2 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-ring min-w-0" />
                <span className="text-xs font-medium w-8 text-center tabular-nums">{(row.left || 0) + (row.right || 0)}</span>
                <button onClick={() => removeRow(idx)} className="text-muted-foreground hover:text-destructive transition flex-shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bulk actions */}
      {rows.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-muted-foreground">Set all rows to:</span>
          {[4, 5, 6, 7, 8, 10].map(n => (
            <button key={n} onClick={() => {
              const next = rows.map(r => ({ ...r, left: n, right: n }))
              setRows(next)
              autoSave(next)
            }}
              className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
              {n} + {n}
            </button>
          ))}
          <button onClick={() => save()} className="ml-auto text-xs px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition flex items-center gap-1">
            <Save className="w-3 h-3" /> {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
