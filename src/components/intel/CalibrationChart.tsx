'use client'

/**
 * Wave 18 — Reliability diagram + drift chart for the calibration
 * dashboard.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (the picture is the
 *     measurement — operators read the diagram, not the Brier score)
 *
 * Two charts:
 *   1) <ReliabilityDiagram> — scatter of (avg predicted, actual booked
 *      rate) per decile. Diagonal line = perfectly calibrated.
 *      Distance off the line = miscalibration.
 *   2) <DriftChart> — bar chart of Brier score across the three
 *      rolling windows (30d / 90d / 365d).
 *
 * recharts is already a dependency (used elsewhere in /intel).
 */

import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  BarChart,
  Bar,
  Legend,
  Cell,
} from 'recharts'
import type { CalibrationBin, DriftWindowRow } from '@/lib/services/calibration/analyze'

interface ReliabilityDiagramProps {
  bins: CalibrationBin[]
}

interface ReliabilityPoint {
  predicted: number
  actual: number
  count: number
  rangeLabel: string
}

export function ReliabilityDiagram({ bins }: ReliabilityDiagramProps) {
  const points: ReliabilityPoint[] = []
  for (const b of bins) {
    if (b.count === 0 || b.avgPredicted === null || b.actualBookedRate === null) continue
    points.push({
      predicted: b.avgPredicted,
      actual: b.actualBookedRate,
      count: b.count,
      rangeLabel: `${b.predictedFloor.toFixed(0)}-${b.predictedCeil.toFixed(0)}%`,
    })
  }

  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-8 text-center text-sm text-zinc-500">
        No reliability bins yet. Predictions need to be matched against
        terminal outcomes before this chart populates.
      </div>
    )
  }

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 32 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis
            type="number"
            dataKey="predicted"
            domain={[0, 100]}
            tickCount={6}
            label={{
              value: 'Predicted close probability (%)',
              position: 'insideBottom',
              offset: -16,
              style: { fontSize: 12, fill: '#52525b' },
            }}
            stroke="#71717a"
          />
          <YAxis
            type="number"
            dataKey="actual"
            domain={[0, 100]}
            tickCount={6}
            label={{
              value: 'Actual booked rate (%)',
              angle: -90,
              position: 'insideLeft',
              offset: 0,
              style: { fontSize: 12, fill: '#52525b' },
            }}
            stroke="#71717a"
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 100, y: 100 },
            ]}
            stroke="#7D8471"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: 'perfect calibration',
              position: 'insideBottomRight',
              fill: '#7D8471',
              fontSize: 11,
            }}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null
              const p = payload[0].payload as ReliabilityPoint
              return (
                <div className="rounded border border-zinc-200 bg-white p-2 text-xs shadow-sm">
                  <div className="font-medium text-zinc-900">{p.rangeLabel} predicted</div>
                  <div className="text-zinc-600">avg predicted: {p.predicted.toFixed(1)}%</div>
                  <div className="text-zinc-600">actual booked: {p.actual.toFixed(1)}%</div>
                  <div className="text-zinc-500">n = {p.count}</div>
                </div>
              )
            }}
          />
          <Scatter name="bin" data={points} fill="#5D7A7A">
            {points.map((p, i) => (
              <Cell
                key={i}
                fill={p.actual >= p.predicted - 5 && p.actual <= p.predicted + 5 ? '#7D8471' : '#A6894A'}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
}

interface DriftChartProps {
  drift: DriftWindowRow[]
}

export function DriftChart({ drift }: DriftChartProps) {
  // Recharts wants a flat array; we emit two series (Brier, Accuracy) per bar.
  const data = drift.map((d) => ({
    window: d.windowLabel,
    brier: d.brierScore !== null ? Number(d.brierScore.toFixed(3)) : 0,
    accuracy: d.accuracyPct ?? 0,
    n: d.n,
  }))

  if (data.every((d) => d.n === 0)) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-center text-sm text-zinc-500">
        Drift chart is empty. Need at least one measured outcome to populate.
      </div>
    )
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 16, right: 24, bottom: 24, left: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis dataKey="window" stroke="#71717a" />
          <YAxis yAxisId="left" stroke="#71717a" />
          <YAxis yAxisId="right" orientation="right" stroke="#71717a" domain={[0, 100]} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null
              const row = data.find((d) => d.window === label)
              if (!row) return null
              return (
                <div className="rounded border border-zinc-200 bg-white p-2 text-xs shadow-sm">
                  <div className="font-medium text-zinc-900">last {label}</div>
                  <div className="text-zinc-600">Brier: {row.brier}</div>
                  <div className="text-zinc-600">Accuracy: {row.accuracy.toFixed(1)}%</div>
                  <div className="text-zinc-500">n = {row.n}</div>
                </div>
              )
            }}
          />
          <Legend />
          <Bar yAxisId="left" dataKey="brier" name="Brier (lower = better)" fill="#5D7A7A" />
          <Bar yAxisId="right" dataKey="accuracy" name="Accuracy %" fill="#A6894A" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
