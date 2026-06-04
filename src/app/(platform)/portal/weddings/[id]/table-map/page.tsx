'use client'

// Admin table map editor: place tables on venue floor plan
// Reads floor plan from venue_config, saves elements to table_map_layouts

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Stage, Layer, Image as KonvaImage, Circle, Rect, Text, Group } from 'react-konva'
import { createClient } from '@/lib/supabase/client'
import { writeOrLog } from '@/lib/db/write-or-log'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import {
  ArrowLeft, ZoomIn, ZoomOut, Maximize, RotateCw, Download, Save,
  Check, Trash2, Loader2, Plus, MousePointer2, BoxSelect, Armchair,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MapElement {
  id: string
  type: 'round' | 'rect' | 'block'
  x: number
  y: number
  feetW: number
  feetH: number
  rotation: number
  label: string
  capacity: number
  color: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId() { return Math.random().toString(36).substr(2, 9) }
const CHAIR_CLEARANCE_FT = 1.5

const RECT_SIZES = Array.from({ length: 16 }, (_, i) => 6 + i * 2)

const BLOCK_TYPES = [
  { label: 'Dance Floor', defaultW: 20, defaultH: 20, color: '#DBEAFE' },
  { label: 'Bar', defaultW: 10, defaultH: 4, color: '#FEF3C7' },
  { label: 'Band / Stage', defaultW: 20, defaultH: 10, color: '#F3E8FF' },
  { label: 'Gift Table', defaultW: 6, defaultH: 3, color: '#FCE7F3' },
  { label: 'Photo Booth', defaultW: 8, defaultH: 8, color: '#ECFDF5' },
  { label: 'Custom', defaultW: 10, defaultH: 10, color: '#E5E7EB' },
]

// ---------------------------------------------------------------------------
// Table element renderer
// ---------------------------------------------------------------------------

function TableEl({ el, pxPerFt, isSelected, onSelect, onMove, onGroupDrag, onGroupDragEnd }: {
  el: MapElement; pxPerFt: number; isSelected: boolean
  onSelect: (id: string, shiftKey: boolean) => void
  onMove: (id: string, x: number, y: number) => void
  /** Called during drag of a selected element so the group can follow.
   *  Receives the absolute new x/y of THIS element so the parent can
   *  derive a delta from the pre-drag position. */
  onGroupDrag?: (id: string, x: number, y: number) => void
  onGroupDragEnd?: (id: string, x: number, y: number) => void
}) {
  const ft = (f: number) => f * pxPerFt
  const w = ft(el.feetW), h = ft(el.feetH)
  const haloExtra = ft(CHAIR_CLEARANCE_FT)
  const isTable = el.type === 'round' || el.type === 'rect'
  const fontSize = Math.max(16, ft(0.85))
  const seatsFontSize = Math.max(13, ft(0.65))
  const strokeColor = isSelected ? '#C9748A' : '#55555566'
  const strokeWidth = isSelected ? ft(0.12) : ft(0.06)

  return (
    <Group x={el.x} y={el.y} rotation={el.rotation || 0} draggable
      onClick={(e: { evt: MouseEvent }) => onSelect(el.id, e.evt.shiftKey)}
      onTap={() => onSelect(el.id, false)}
      onDragMove={e => {
        e.cancelBubble = true
        if (isSelected && onGroupDrag) {
          onGroupDrag(el.id, e.target.x(), e.target.y())
        }
      }}
      onDragEnd={e => {
        e.cancelBubble = true
        if (isSelected && onGroupDragEnd) {
          onGroupDragEnd(el.id, e.target.x(), e.target.y())
        } else {
          onMove(el.id, e.target.x(), e.target.y())
        }
      }}
    >
      {isTable && el.type === 'round' && (
        <Circle radius={w/2+haloExtra} fill="rgba(96,165,250,0.10)" stroke="#93C5FD" strokeWidth={ft(0.05)} listening={false} />
      )}
      {isTable && el.type === 'rect' && (
        <Rect x={-(w/2+haloExtra)} y={-(h/2+haloExtra)} width={w+haloExtra*2} height={h+haloExtra*2}
          fill="rgba(96,165,250,0.10)" stroke="#93C5FD" strokeWidth={ft(0.05)} cornerRadius={ft(0.4)} listening={false} />
      )}
      {el.type === 'round' ? (
        <Circle radius={w/2} fill={el.color} stroke={strokeColor} strokeWidth={strokeWidth} />
      ) : (
        <Rect x={-w/2} y={-h/2} width={w} height={h} fill={el.color} stroke={strokeColor} strokeWidth={strokeWidth}
          cornerRadius={el.type === 'block' ? ft(0.25) : ft(0.08)} />
      )}
      <Text text={el.label} x={-w/2} y={-fontSize*0.75} width={w} align="center"
        fontSize={fontSize} fontStyle="bold" fill="#000" listening={false} />
      {el.capacity > 0 && (
        <Text text={`${el.capacity} seats`} x={-w/2} y={fontSize*0.35} width={w} align="center"
          fontSize={seatsFontSize} fontStyle="bold" fill="#333" listening={false} />
      )}
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Block prompt modal
// ---------------------------------------------------------------------------

function BlockPrompt({ preset, onConfirm, onCancel }: {
  preset: typeof BLOCK_TYPES[0]
  onConfirm: (w: number, h: number) => void
  onCancel: () => void
}) {
  const [w, setW] = useState(preset.defaultW)
  const [h, setH] = useState(preset.defaultH)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 max-w-xs w-full">
        <h3 className="font-semibold mb-1">Add {preset.label}</h3>
        <p className="text-xs text-muted-foreground mb-4">Enter dimensions in feet</p>
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Width (ft)</label>
            <input type="number" min={1} max={200} value={w} onChange={e => setW(parseFloat(e.target.value) || 1)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Depth (ft)</label>
            <input type="number" min={1} max={200} value={h} onChange={e => setH(parseFloat(e.target.value) || 1)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => onConfirm(w, h)}
            className="flex-1 bg-primary text-primary-foreground rounded-xl py-2 text-sm font-medium hover:opacity-90 transition">
            Add to Layout
          </button>
          <button onClick={onCancel} className="px-4 border rounded-xl text-sm hover:bg-muted/50 transition">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main admin editor
// ---------------------------------------------------------------------------

export default function AdminTableMapEditor() {
  const { id: weddingId } = useParams<{ id: string }>()
  const supabase = createClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<typeof Stage.prototype>(null)

  const [venueId, setVenueId] = useState<string | null>(null)
  const [floorPlanUrl, setFloorPlanUrl] = useState<string | null>(null)
  const [venueWidthFt, setVenueWidthFt] = useState(80)
  const [floorImg, setFloorImg] = useState<HTMLImageElement | null>(null)
  const [imgW, setImgW] = useState(1600)
  const [imgH, setImgH] = useState(900)

  const [stageW, setStageW] = useState(900)
  const [stageH, setStageH] = useState(500)
  const [zoom, setZoom] = useState<number | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [planRotation, setPlanRotation] = useState(0)

  const [elements, setElements] = useState<MapElement[]>([])
  // Task #11 — multi-select. Set replaces the prior single-id state.
  // Most code paths treat size===1 the same as the legacy single-select
  // (still shows the edit-props panel, delete button, etc.).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [showRectPicker, setShowRectPicker] = useState(false)
  const [blockPrompt, setBlockPrompt] = useState<typeof BLOCK_TYPES[0] | null>(null)

  // Task #11 — marquee selection. When `selectMode` is on, dragging on
  // empty canvas creates a selection rectangle; clicking a table toggles
  // it in/out of the selection. When off, behaviour matches the original
  // single-select editor (drag = pan, click = select one).
  const [selectMode, setSelectMode] = useState(false)
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const marqueeStart = useRef<{ x: number; y: number } | null>(null)
  // Group drag: snapshot positions at drag start so deltas can be
  // applied across the selection without compounding rounding errors.
  const dragSnapshot = useRef<Map<string, { x: number; y: number }> | null>(null)

  // Load wedding -> venue -> floor plan config
  useEffect(() => {
    ;(async () => {
      const { data: w } = await supabase.from('weddings').select('venue_id').eq('id', weddingId).single()
      if (!w?.venue_id) { setLoading(false); return }
      setVenueId(w.venue_id)

      const { data: vc } = await supabase.from('venue_config').select('feature_flags').eq('venue_id', w.venue_id).maybeSingle()
      const f = (vc?.feature_flags ?? {}) as Record<string, unknown>
      setFloorPlanUrl((f.floor_plan_url as string) || null)
      setVenueWidthFt((f.floor_plan_venue_width_ft as number) || 80)

      const { data: layout } = await supabase.from('table_map_layouts').select('elements').eq('wedding_id', weddingId).maybeSingle()
      if (layout?.elements) setElements(layout.elements as MapElement[])
      setLoading(false)
    })()
  }, [weddingId])

  // Load image
  useEffect(() => {
    if (!floorPlanUrl) return
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.src = floorPlanUrl
    img.onload = () => { setFloorImg(img); setImgW(img.naturalWidth); setImgH(img.naturalHeight) }
  }, [floorPlanUrl])

  const isLandscape = planRotation % 180 === 0
  const effectiveW = isLandscape ? imgW : imgH
  const effectiveH = isLandscape ? imgH : imgW

  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return
      const w = containerRef.current.offsetWidth
      const h = Math.round(w * effectiveH / effectiveW)
      setStageW(w); setStageH(h)
      setZoom(w / effectiveW); setPos({ x: 0, y: 0 })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [planRotation, effectiveW, effectiveH])

  const pxPerFt = imgW / venueWidthFt
  const fitScale = stageW / effectiveW
  const currentZoom = zoom ?? fitScale

  const viewCentre = () => ({
    x: (stageW / 2 - pos.x) / currentZoom,
    y: (stageH / 2 - pos.y) / currentZoom,
  })

  const addRound = (feetW: number, label: string, capacity: number) => {
    const c = viewCentre()
    setElements(prev => [...prev, { id: genId(), type: 'round', x: c.x, y: c.y, feetW, feetH: feetW, rotation: 0, label, capacity, color: '#F5EDE0' }])
  }

  const addRect = (size: number) => {
    const c = viewCentre()
    setElements(prev => [...prev, { id: genId(), type: 'rect', x: c.x, y: c.y, feetW: size, feetH: 2.5, rotation: 0, label: `${size}ft Table`, capacity: size, color: '#F5EDE0' }])
    setShowRectPicker(false)
  }

  const addBlock = (preset: typeof BLOCK_TYPES[0], fw: number, fh: number) => {
    const c = viewCentre()
    setElements(prev => [...prev, { id: genId(), type: 'block', x: c.x, y: c.y, feetW: fw, feetH: fh, rotation: 0, label: preset.label, capacity: 0, color: preset.color }])
    setBlockPrompt(null)
  }

  // Single-selection helpers — only meaningful when exactly one item
  // is in the set. The edit-props panel and updateSelected work off
  // this derived id.
  const singleSelectedId = selectedIds.size === 1 ? [...selectedIds][0] : null

  const updateSelected = (changes: Partial<MapElement>) => {
    if (!singleSelectedId) return
    setElements(prev => prev.map(el => el.id === singleSelectedId ? { ...el, ...changes } : el))
  }

  // Task #11 — deletes EVERY selected element. Backwards-compatible
  // with the legacy single-select case (set size 1).
  const deleteSelected = () => {
    if (selectedIds.size === 0) return
    setElements(prev => prev.filter(el => !selectedIds.has(el.id)))
    setSelectedIds(new Set())
  }

  const moveElement = (id: string, x: number, y: number) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, x, y } : el))
  }

  // Task #11 — toggle id into the selection. Shift-click extends/
  // toggles; plain click replaces the selection with just this id.
  const toggleSelection = (id: string, shiftKey: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (shiftKey) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      } else {
        next.clear()
        next.add(id)
      }
      return next
    })
  }

  // Task #11 — group drag. When a selected table is dragged with
  // others selected, compute the delta from the snapshot taken at
  // drag start and apply it to every other selected element. Konva
  // already moves the dragged element itself; this updates the rest
  // of the group to match.
  const handleGroupDrag = (id: string, newX: number, newY: number) => {
    if (selectedIds.size <= 1) return
    if (!dragSnapshot.current) {
      // First DragMove tick — snapshot all selected positions so
      // subsequent deltas don't compound.
      const snap = new Map<string, { x: number; y: number }>()
      for (const el of elements) {
        if (selectedIds.has(el.id)) snap.set(el.id, { x: el.x, y: el.y })
      }
      dragSnapshot.current = snap
    }
    const anchor = dragSnapshot.current.get(id)
    if (!anchor) return
    const dx = newX - anchor.x
    const dy = newY - anchor.y
    setElements(prev =>
      prev.map(el => {
        if (!selectedIds.has(el.id)) return el
        if (el.id === id) return el // konva already moved this one
        const snap = dragSnapshot.current!.get(el.id)
        if (!snap) return el
        return { ...el, x: snap.x + dx, y: snap.y + dy }
      })
    )
  }

  const handleGroupDragEnd = (id: string, newX: number, newY: number) => {
    if (selectedIds.size <= 1) {
      moveElement(id, newX, newY)
      dragSnapshot.current = null
      return
    }
    // Commit final delta (in case DragMove never fired, e.g. tiny drag)
    handleGroupDrag(id, newX, newY)
    // Also ensure the dragged element's own position is reflected
    setElements(prev => prev.map(el => el.id === id ? { ...el, x: newX, y: newY } : el))
    dragSnapshot.current = null
  }

  const handleWheel = useCallback((e: { evt: WheelEvent }) => {
    e.evt.preventDefault()
    const factor = e.evt.deltaY < 0 ? 1.1 : 0.909
    setZoom(z => Math.min(fitScale * 10, Math.max(fitScale * 0.5, (z ?? fitScale) * factor)))
  }, [fitScale])

  // Task #11 — transform an element's local (x, y) into Stage-relative
  // coords, accounting for the inner Group's offset + planRotation +
  // translate. Used by the marquee intersection test.
  const elCentreInStageCoords = useCallback((el: MapElement) => {
    const dx = el.x - imgW / 2
    const dy = el.y - imgH / 2
    const rad = (planRotation * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    return {
      x: dx * cos - dy * sin + effectiveW / 2,
      y: dx * sin + dy * cos + effectiveH / 2,
    }
  }, [imgW, imgH, planRotation, effectiveW, effectiveH])

  // Task #11 — marquee handlers. Only active when selectMode is on AND
  // the pointer-down hit the Stage itself (not a child node). Stage
  // panning is disabled in selectMode (Stage `draggable={!selectMode}`).
  type KonvaPointerEvt = {
    target: { getStage: () => unknown }
    evt: MouseEvent
  }
  const handleMarqueeDown = (e: KonvaPointerEvt) => {
    if (!selectMode) return
    if (e.target !== e.target.getStage()) return
    const stage = stageRef.current as unknown as { getRelativePointerPosition: () => { x: number; y: number } } | null
    if (!stage) return
    const p = stage.getRelativePointerPosition()
    marqueeStart.current = p
    setMarquee({ x: p.x, y: p.y, width: 0, height: 0 })
  }
  const handleMarqueeMove = () => {
    if (!selectMode || !marqueeStart.current) return
    const stage = stageRef.current as unknown as { getRelativePointerPosition: () => { x: number; y: number } } | null
    if (!stage) return
    const p = stage.getRelativePointerPosition()
    const s = marqueeStart.current
    setMarquee({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      width: Math.abs(p.x - s.x),
      height: Math.abs(p.y - s.y),
    })
  }
  const handleMarqueeUp = (e: KonvaPointerEvt) => {
    if (!selectMode || !marqueeStart.current) return
    const rect = marquee
    marqueeStart.current = null
    setMarquee(null)
    if (!rect || rect.width < 3 || rect.height < 3) {
      // Treat as a stage click — clear selection unless shift held.
      if (!e.evt.shiftKey) setSelectedIds(new Set())
      return
    }
    const hits = new Set<string>()
    if (e.evt.shiftKey) {
      selectedIds.forEach(id => hits.add(id))
    }
    for (const el of elements) {
      const c = elCentreInStageCoords(el)
      if (
        c.x >= rect.x && c.x <= rect.x + rect.width &&
        c.y >= rect.y && c.y <= rect.y + rect.height
      ) {
        hits.add(el.id)
      }
    }
    setSelectedIds(hits)
  }

  // Task #11 — Delete/Backspace shortcut. Only fires when the active
  // element isn't a form input (so editing the props panel doesn't
  // accidentally nuke the layout).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      if (selectedIds.size === 0) return
      e.preventDefault()
      deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds])

  const handleSave = async () => {
    setSaving(true)
    await writeOrLog(supabase.from('table_map_layouts').upsert(
      { wedding_id: weddingId, elements, updated_at: new Date().toISOString() },
      { onConflict: 'wedding_id' }
    ), { op: 'table_map_layouts.upsert', venueId })
    setSaving(false); setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const exportPng = () => {
    if (!stageRef.current) return
    const uri = (stageRef.current as unknown as { toDataURL: (o: { pixelRatio: number }) => string }).toDataURL({ pixelRatio: 4 })
    const a = document.createElement('a'); a.download = 'table-map.png'; a.href = uri; a.click()
  }

  const fitToScreen = () => { setZoom(fitScale); setPos({ x: 0, y: 0 }) }
  const rotatePlan = () => setPlanRotation(r => (r + 90) % 360)

  const selectedEl = singleSelectedId ? elements.find(e => e.id === singleSelectedId) ?? null : null

  // Task #10 — auto-sum seats across all seating elements. Blocks
  // (Dance Floor / Bar / Stage / etc.) don't contribute since their
  // capacity is 0. Memoised so it doesn't recompute on pan/zoom.
  const totalSeats = useMemo(
    () => elements.reduce((sum, el) => sum + (el.type === 'block' ? 0 : (el.capacity || 0)), 0),
    [elements]
  )
  const tableCount = useMemo(
    () => elements.filter(el => el.type !== 'block').length,
    [elements]
  )

  if (loading) return <div className="text-muted-foreground text-center py-16">Loading table map editor...</div>

  if (!floorPlanUrl) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <p className="text-muted-foreground mb-4">No floor plan uploaded for this venue.</p>
        <p className="text-sm text-muted-foreground">Go to <strong>Venue Config &gt; Seating Config</strong> to upload one.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/portal/weddings/${weddingId}`} className="p-2 rounded-lg hover:bg-muted/50 transition">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Table Map Editor</h1>
          <p className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
            <span>{elements.length} element{elements.length !== 1 ? 's' : ''} placed</span>
            {/* Task #10 — live seat total. Hidden when no tables exist
                yet so the empty editor stays clean. */}
            {tableCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Armchair className="w-3 h-3" />
                {totalSeats} seat{totalSeats === 1 ? '' : 's'} across {tableCount} table{tableCount === 1 ? '' : 's'}
              </span>
            )}
            {selectedIds.size > 1 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                {selectedIds.size} selected
              </span>
            )}
          </p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className={cn('inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition',
            saved ? 'bg-green-500 text-white' : 'bg-primary text-primary-foreground hover:opacity-90',
            'disabled:opacity-50')}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Layout'}
        </button>
      </div>

      {/* Toolbar: add elements */}
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-muted-foreground uppercase tracking-wide w-16">Round</span>
          <button onClick={() => addRound(5, '60" Round', 8)} className="px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">60" (8)</button>
          <button onClick={() => addRound(6, '72" Round', 10)} className="px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">72" (10)</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-muted-foreground uppercase tracking-wide w-16">Rect</span>
          <button onClick={() => setShowRectPicker(v => !v)}
            className={cn('px-3 py-1.5 rounded-lg border transition', showRectPicker && 'bg-muted')}>
            Choose size...
          </button>
          {showRectPicker && (
            <div className="flex flex-wrap gap-1">
              {RECT_SIZES.map(s => (
                <button key={s} onClick={() => addRect(s)} className="px-2 py-1 rounded border bg-white hover:bg-muted/50 transition">{s}ft</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-muted-foreground uppercase tracking-wide w-16">Blocks</span>
          {BLOCK_TYPES.map(b => (
            <button key={b.label} onClick={() => { setBlockPrompt(b); setShowRectPicker(false) }}
              className={cn('px-3 py-1.5 rounded-lg border transition', blockPrompt?.label === b.label && 'bg-muted')}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Canvas controls */}
      <div className="flex items-center gap-2 flex-wrap border-t pt-2">
        <button onClick={rotatePlan} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <RotateCw className="w-3 h-3" /> Rotate
        </button>
        <button onClick={fitToScreen} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <Maximize className="w-3 h-3" /> Fit
        </button>
        <button onClick={() => setZoom(z => Math.min(fitScale*10, (z??fitScale)*1.25))} className="text-xs px-2 py-1.5 rounded-lg border hover:bg-muted/50 transition"><ZoomIn className="w-3 h-3" /></button>
        <button onClick={() => setZoom(z => Math.max(fitScale*0.5, (z??fitScale)*0.8))} className="text-xs px-2 py-1.5 rounded-lg border hover:bg-muted/50 transition"><ZoomOut className="w-3 h-3" /></button>
        <span className="text-xs text-muted-foreground">{Math.round(currentZoom / fitScale * 100)}%</span>
        {/* Task #11 — select-mode toggle. When ON, dragging on empty
            canvas creates a marquee; click+shift extends the selection.
            When OFF, drag pans (legacy behaviour). */}
        <button
          onClick={() => { setSelectMode(m => !m); setMarquee(null); marqueeStart.current = null }}
          className={cn(
            'text-xs px-3 py-1.5 rounded-lg border transition inline-flex items-center gap-1.5',
            selectMode
              ? 'bg-primary text-primary-foreground border-primary'
              : 'hover:bg-muted/50'
          )}
          title={selectMode ? 'Switch back to pan' : 'Drag to multi-select'}
        >
          {selectMode ? <BoxSelect className="w-3 h-3" /> : <MousePointer2 className="w-3 h-3" />}
          {selectMode ? 'Select mode' : 'Multi-select'}
        </button>
        <div className="ml-auto flex gap-2">
          {selectedIds.size > 0 && (
            <button onClick={deleteSelected} className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition">
              <Trash2 className="w-3 h-3 inline mr-1" />
              {selectedIds.size > 1 ? `Delete ${selectedIds.size}` : 'Delete'}
            </button>
          )}
          <button onClick={exportPng} className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
            <Download className="w-3 h-3 inline mr-1" /> Export PNG
          </button>
        </div>
      </div>

      {/* Selected element properties */}
      {selectedEl && (
        <div className="flex flex-wrap items-end gap-3 p-3 bg-muted/30 rounded-xl border">
          <div>
            <label className="block text-xs text-muted-foreground mb-0.5">Label</label>
            <input className="border rounded-lg px-2 py-1 text-sm w-36 focus:outline-none focus:ring-1 focus:ring-ring"
              value={selectedEl.label} onChange={e => updateSelected({ label: e.target.value })} />
          </div>
          {selectedEl.type !== 'block' && (
            <div>
              <label className="block text-xs text-muted-foreground mb-0.5">Seats</label>
              <input type="number" min={1} className="border rounded-lg px-2 py-1 text-sm w-16 focus:outline-none focus:ring-1 focus:ring-ring"
                value={selectedEl.capacity} onChange={e => updateSelected({ capacity: parseInt(e.target.value) || 0 })} />
            </div>
          )}
          {selectedEl.type === 'block' && (
            <>
              <div>
                <label className="block text-xs text-muted-foreground mb-0.5">Width (ft)</label>
                <input type="number" min={1} className="border rounded-lg px-2 py-1 text-sm w-16 focus:outline-none focus:ring-1 focus:ring-ring"
                  value={selectedEl.feetW} onChange={e => updateSelected({ feetW: parseFloat(e.target.value) || 1 })} />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-0.5">Depth (ft)</label>
                <input type="number" min={1} className="border rounded-lg px-2 py-1 text-sm w-16 focus:outline-none focus:ring-1 focus:ring-ring"
                  value={selectedEl.feetH} onChange={e => updateSelected({ feetH: parseFloat(e.target.value) || 1 })} />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs text-muted-foreground mb-0.5">Rotation</label>
            <input type="number" className="border rounded-lg px-2 py-1 text-sm w-16 focus:outline-none focus:ring-1 focus:ring-ring"
              value={selectedEl.rotation || 0} onChange={e => updateSelected({ rotation: parseInt(e.target.value) || 0 })} />
          </div>
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-muted-foreground hover:text-foreground pb-1">Done</button>
        </div>
      )}

      {/* Canvas */}
      <div ref={containerRef} className={cn(
        'border rounded-xl overflow-hidden bg-muted/20 select-none',
        selectMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      )}>
        <Stage
          ref={stageRef as React.RefObject<never>}
          width={stageW} height={stageH}
          scaleX={currentZoom} scaleY={currentZoom}
          x={pos.x} y={pos.y}
          // Task #11 — disable pan-by-drag when selectMode is on so the
          // marquee can claim mouse events.
          draggable={!selectMode}
          onWheel={handleWheel}
          onDragEnd={(e: { target: { x: () => number; y: () => number } }) => setPos({ x: e.target.x(), y: e.target.y() })}
          onMouseDown={handleMarqueeDown}
          onMouseMove={handleMarqueeMove}
          onMouseUp={handleMarqueeUp}
          onClick={(e: { target: { getStage: () => unknown }; evt: MouseEvent }) => {
            // Only clear via plain click when NOT in selectMode (marquee
            // up handles that). Shift+click on empty preserves selection.
            if (selectMode) return
            if (e.target === e.target.getStage() && !e.evt.shiftKey) setSelectedIds(new Set())
          }}
        >
          <Layer>
            <Group rotation={planRotation} offsetX={imgW/2} offsetY={imgH/2} x={effectiveW/2} y={effectiveH/2}>
              {floorImg && <KonvaImage image={floorImg} x={0} y={0} width={imgW} height={imgH} />}
            </Group>
          </Layer>
          <Layer>
            <Group rotation={planRotation} offsetX={imgW/2} offsetY={imgH/2} x={effectiveW/2} y={effectiveH/2}>
              {elements.map(el => (
                <TableEl
                  key={el.id}
                  el={el}
                  pxPerFt={pxPerFt}
                  isSelected={selectedIds.has(el.id)}
                  onSelect={toggleSelection}
                  onMove={moveElement}
                  onGroupDrag={handleGroupDrag}
                  onGroupDragEnd={handleGroupDragEnd}
                />
              ))}
            </Group>
          </Layer>
          {/* Task #11 — marquee overlay. Sits in the same Stage-relative
              space as the marquee coordinates (NOT inside the rotated
              Group), so it visually tracks the cursor regardless of plan
              rotation. */}
          {marquee && (
            <Layer listening={false}>
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgba(96, 165, 250, 0.12)"
                stroke="#3B82F6"
                strokeWidth={1 / currentZoom}
                dash={[6 / currentZoom, 4 / currentZoom]}
              />
            </Layer>
          )}
        </Stage>
      </div>

      {blockPrompt && (
        <BlockPrompt preset={blockPrompt}
          onConfirm={(fw, fh) => addBlock(blockPrompt, fw, fh)}
          onCancel={() => setBlockPrompt(null)} />
      )}
    </div>
  )
}
