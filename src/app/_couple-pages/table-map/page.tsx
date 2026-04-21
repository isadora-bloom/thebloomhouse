'use client'

// Feature: Interactive table map on venue floor plan (Konva canvas)
// Table: table_map_layouts (wedding_id UNIQUE, elements JSONB)
// Config: venue_config.feature_flags.floor_plan_url, floor_plan_venue_width_ft

import { useState, useEffect, useRef, useCallback } from 'react'
import { Stage, Layer, Image as KonvaImage, Circle, Rect, Text, Group } from 'react-konva'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { ZoomIn, ZoomOut, Maximize, RotateCw, Download, Crop, Save, Check } from 'lucide-react'

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

interface FloorPlanConfig {
  url: string | null
  widthFt: number
  depthFt: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId() { return Math.random().toString(36).substr(2, 9) }

const CHAIR_CLEARANCE_FT = 1.5

// ---------------------------------------------------------------------------
// Element renderer
// ---------------------------------------------------------------------------

function TableEl({ el, pxPerFt, isSelected, isAdmin, onSelect, onMove }: {
  el: MapElement
  pxPerFt: number
  isSelected: boolean
  isAdmin: boolean
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
}) {
  const ft = (f: number) => f * pxPerFt
  const w = ft(el.feetW)
  const h = ft(el.feetH)
  const haloExtra = ft(CHAIR_CLEARANCE_FT)
  const isTable = el.type === 'round' || el.type === 'rect'
  const fontSize = Math.max(16, ft(0.85))
  const seatsFontSize = Math.max(13, ft(0.65))
  const strokeColor = isSelected ? '#C9748A' : '#55555566'
  const strokeWidth = isSelected ? ft(0.12) : ft(0.06)

  return (
    <Group
      x={el.x} y={el.y} rotation={el.rotation || 0}
      draggable={isAdmin}
      onClick={() => isAdmin && onSelect(el.id)}
      onTap={() => isAdmin && onSelect(el.id)}
      onDragEnd={e => { e.cancelBubble = true; if (isAdmin) onMove(el.id, e.target.x(), e.target.y()) }}
    >
      {isTable && el.type === 'round' && (
        <Circle radius={w / 2 + haloExtra} fill="rgba(96,165,250,0.10)" stroke="#93C5FD" strokeWidth={ft(0.05)} listening={false} />
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
// Main component
// ---------------------------------------------------------------------------

export default function TableMapPage() {
  const { weddingId, venueId } = useCoupleContext()
  const supabase = createClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<typeof Stage.prototype>(null)

  const [config, setConfig] = useState<FloorPlanConfig>({ url: null, widthFt: 80, depthFt: 45 })
  const [floorImg, setFloorImg] = useState<HTMLImageElement | null>(null)
  const [imgW, setImgW] = useState(1600)
  const [imgH, setImgH] = useState(900)

  const [stageW, setStageW] = useState(900)
  const [stageH, setStageH] = useState(500)
  const [zoom, setZoom] = useState<number | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [planRotation, setPlanRotation] = useState(0)

  const [elements, setElements] = useState<MapElement[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Load venue config + floor plan
  useEffect(() => {
    if (!venueId) return
    ;(async () => {
      const { data } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (data?.feature_flags) {
        const f = data.feature_flags as Record<string, unknown>
        setConfig({
          url: (f.floor_plan_url as string) || null,
          widthFt: (f.floor_plan_venue_width_ft as number) || 80,
          depthFt: (f.floor_plan_venue_depth_ft as number) || 45,
        })
      }
    })()
  }, [venueId])

  // Load floor plan image
  useEffect(() => {
    if (!config.url) return
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.src = config.url
    img.onload = () => { setFloorImg(img); setImgW(img.naturalWidth); setImgH(img.naturalHeight) }
  }, [config.url])

  // Effective dimensions based on rotation
  const isLandscape = planRotation % 180 === 0
  const effectiveW = isLandscape ? imgW : imgH
  const effectiveH = isLandscape ? imgH : imgW

  // Size stage to container
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return
      const w = containerRef.current.offsetWidth
      const h = Math.round(w * effectiveH / effectiveW)
      setStageW(w)
      setStageH(h)
      setZoom(w / effectiveW)
      setPos({ x: 0, y: 0 })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [planRotation, effectiveW, effectiveH])

  // Load saved layout
  useEffect(() => {
    if (!weddingId) return
    ;(async () => {
      const { data } = await supabase
        .from('table_map_layouts')
        .select('elements')
        .eq('wedding_id', weddingId)
        .maybeSingle()
      if (data?.elements) setElements(data.elements)
      setLoading(false)
    })()
  }, [weddingId])

  const pxPerFt = imgW / config.widthFt
  const fitScale = stageW / effectiveW
  const currentZoom = zoom ?? fitScale

  const fitToScreen = () => { setZoom(fitScale); setPos({ x: 0, y: 0 }) }
  const rotatePlan = () => setPlanRotation(r => (r + 90) % 360)

  const exportPng = () => {
    if (!stageRef.current) return
    const uri = (stageRef.current as { toDataURL: (o: { pixelRatio: number }) => string }).toDataURL({ pixelRatio: 4 })
    const a = document.createElement('a')
    a.download = 'table-map.png'
    a.href = uri
    a.click()
  }

  const moveElement = (id: string, x: number, y: number) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, x, y } : el))
  }

  const handleWheel = useCallback((e: { evt: WheelEvent }) => {
    e.evt.preventDefault()
    const factor = e.evt.deltaY < 0 ? 1.1 : 0.909
    setZoom(z => Math.min(fitScale * 10, Math.max(fitScale * 0.5, (z ?? fitScale) * factor)))
  }, [fitScale])

  if (!config.url) {
    return (
      <div className="bg-muted/30 rounded-2xl border p-12 text-center">
        <p className="text-muted-foreground text-sm">Your venue hasn&apos;t uploaded a floor plan yet. Your coordinator will set this up.</p>
      </div>
    )
  }

  if (loading) return <div className="text-muted-foreground text-center py-8">Loading table map...</div>

  // Client view: no layout yet
  if (elements.length === 0) {
    return (
      <div className="bg-muted/30 rounded-2xl border p-12 text-center">
        <p className="text-muted-foreground text-sm">Your seating layout will appear here once your coordinator has set it up.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Table Map</h1>
          <p className="text-sm text-muted-foreground">Your reception floor plan</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={rotatePlan} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <RotateCw className="w-3.5 h-3.5" /> Rotate
        </button>
        <button onClick={fitToScreen} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <Maximize className="w-3.5 h-3.5" /> Fit
        </button>
        <button onClick={() => setZoom(z => Math.min(fitScale * 10, (z ?? fitScale) * 1.25))} className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setZoom(z => Math.max(fitScale * 0.5, (z ?? fitScale) * 0.8))} className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs text-muted-foreground">{Math.round(currentZoom / fitScale * 100)}%</span>
        <button onClick={exportPng} className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition">
          <Download className="w-3.5 h-3.5" /> Export PNG
        </button>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="border rounded-xl overflow-hidden bg-muted/20 cursor-grab active:cursor-grabbing select-none">
        <Stage
          ref={stageRef as React.RefObject<never>}
          width={stageW}
          height={stageH}
          scaleX={currentZoom}
          scaleY={currentZoom}
          x={pos.x}
          y={pos.y}
          draggable
          onWheel={handleWheel}
          onDragEnd={(e: { target: { x: () => number; y: () => number } }) => {
            setPos({ x: e.target.x(), y: e.target.y() })
          }}
          onClick={() => setSelectedId(null)}
        >
          <Layer>
            <Group
              rotation={planRotation}
              offsetX={imgW / 2} offsetY={imgH / 2}
              x={effectiveW / 2} y={effectiveH / 2}
            >
              {floorImg && <KonvaImage image={floorImg} x={0} y={0} width={imgW} height={imgH} />}
            </Group>
          </Layer>
          <Layer>
            <Group
              rotation={planRotation}
              offsetX={imgW / 2} offsetY={imgH / 2}
              x={effectiveW / 2} y={effectiveH / 2}
            >
              {elements.map(el => (
                <TableEl
                  key={el.id}
                  el={el}
                  pxPerFt={pxPerFt}
                  isSelected={selectedId === el.id}
                  isAdmin={false}
                  onSelect={setSelectedId}
                  onMove={moveElement}
                />
              ))}
            </Group>
          </Layer>
        </Stage>
      </div>
    </div>
  )
}
