/**
 * Platform-shift view model tests (NOVEMBER-PLAN.md wave 7, W48).
 *
 * Same discipline as channel-view.test.ts: the view is a pure function of
 * a PlatformShiftResult, so give it the same input and it renders the
 * same headline and rows every time.
 */
import { describe, it, expect } from 'vitest'
import { computePlatformShift } from '@/lib/intel/tool-sources/platform-shift'
import { buildPlatformShiftView } from '../platform-shift-view'

const TODAY = '2026-09-01'

describe('buildPlatformShiftView', () => {
  it('names the platform gaining share and the one losing it', () => {
    const result = computePlatformShift(
      [
        { source: 'instagram', metric: 'likes', label: '2026-07', value: 800 },
        { source: 'instagram', metric: 'likes', label: '2026-08', value: 650 },
        { source: 'instagram', metric: 'likes', label: '2026-09', value: 500 },
        { source: 'tiktok', metric: 'likes', label: '2026-07', value: 200 },
        { source: 'tiktok', metric: 'likes', label: '2026-08', value: 450 },
        { source: 'tiktok', metric: 'likes', label: '2026-09', value: 900 },
      ],
      TODAY,
      3,
    )
    const view = buildPlatformShiftView(result)
    expect(view.headline).toContain('Instagram')
    expect(view.headline).toContain('TikTok')
    expect(view.headline).toMatch(/shifting from Instagram to TikTok/)
  })

  it('is honest when there is no data at all', () => {
    const result = computePlatformShift([], TODAY, 3)
    const view = buildPlatformShiftView(result)
    expect(view.enoughData).toBe(false)
    // Plain copy on the card. The tool-source's diagnosis
    // ("No marketing_metric rows ...") stays on the result for the
    // Ask-your-data tool and must not be the coordinator's headline.
    expect(view.headline).toBe('No platform engagement data yet.')
    expect(result.reason).toMatch(/marketing_metric/)
    expect(view.headline).not.toMatch(/marketing_metric/)
    expect(view.rows.every((r) => !r.hasData)).toBe(true)
  })

  it('does not claim a shift when only one platform has data', () => {
    const result = computePlatformShift(
      [{ source: 'instagram', metric: 'likes', label: '2026-07', value: 100 }],
      TODAY,
      3,
    )
    const view = buildPlatformShiftView(result)
    expect(view.headline).toMatch(/Only Instagram has data/)
  })

  it('is a pure function of the result — same input, identical output', () => {
    const result = computePlatformShift(
      [{ source: 'pinterest', metric: 'saves', label: '2026-07', value: 30 }],
      TODAY,
      3,
    )
    const a = buildPlatformShiftView(result)
    const b = buildPlatformShiftView(result)
    expect(a).toEqual(b)
  })
})
