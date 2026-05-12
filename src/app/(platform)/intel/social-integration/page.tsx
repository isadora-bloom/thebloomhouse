'use client'

/**
 * /intel/social-integration -- weekly capture loop for social engagement
 * data the platforms don't expose via API. V1 ships Instagram New
 * Followers as the only functional metric; everything else renders in
 * the layout but is gated with a "coming soon" tooltip.
 *
 * Constitution thesis: a couple who followed the venue on Instagram
 * three weeks before submitting an inquiry is attribution credit. This
 * page is the substrate for that signal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { PlatformCard, type PlatformDef, type MetricState } from '@/components/intel/social/PlatformCard'
import { CaptureNowModal } from '@/components/intel/social/CaptureNowModal'

const PLATFORMS: PlatformDef[] = [
  {
    key: 'instagram',
    name: 'Instagram',
    icon: 'instagram',
    metrics: [
      {
        metric_type: 'new_followers',
        label: 'New Followers',
        recommendedFrequency: 'Weekly',
        functional: true,
      },
      {
        metric_type: 'profile_visits',
        label: 'Profile Visits',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'story_views',
        label: 'Story Views',
        recommendedFrequency: 'Daily',
        functional: false,
      },
      {
        metric_type: 'post_engagement',
        label: 'Post Engagement',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'dms',
        label: 'DMs',
        recommendedFrequency: 'Daily',
        functional: false,
      },
    ],
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    icon: 'tiktok',
    metrics: [
      {
        metric_type: 'new_followers',
        label: 'New Followers',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'profile_views',
        label: 'Profile Views',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'video_engagement',
        label: 'Video Engagement',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
    ],
  },
  {
    key: 'facebook',
    name: 'Facebook',
    icon: 'facebook',
    metrics: [
      {
        metric_type: 'page_likes',
        label: 'Page Likes',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'post_engagement',
        label: 'Post Engagement',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
    ],
  },
  {
    key: 'pinterest',
    name: 'Pinterest',
    icon: 'pinterest',
    metrics: [
      {
        metric_type: 'saves',
        label: 'Saves',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'board_follows',
        label: 'Board Follows',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
      {
        metric_type: 'profile_visits',
        label: 'Profile Visits',
        recommendedFrequency: 'Weekly',
        functional: false,
      },
    ],
  },
]

interface StateMetricRow {
  platform: string
  metric_type: string
  last_captured_at: string | null
  status_color: 'sage' | 'amber' | 'rose'
  recommended_frequency_days: number | null
  total_handles: number | null
  matched_count: number | null
}

interface StateConfigRow {
  platform: string
  venue_handle: string | null
  followers_url: string | null
  recommended_frequency_days: number | null
  is_active: boolean
}

interface StateResponse {
  metrics: StateMetricRow[]
  configs: StateConfigRow[]
}

export default function SocialIntegrationPage() {
  const [loading, setLoading] = useState(true)
  const [stateData, setStateData] = useState<StateResponse | null>(null)
  const [modal, setModal] = useState<{
    platform: 'instagram'
    metricType: 'new_followers'
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/intel/social-integration/state')
      if (!resp.ok) {
        setStateData({ metrics: [], configs: [] })
        return
      }
      const j = (await resp.json()) as StateResponse
      setStateData(j)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Build the (platform -> metric_type -> MetricState) map.
  const stateByPlatformMetric = useMemo(() => {
    const out = new Map<string, Map<string, MetricState>>()
    for (const m of stateData?.metrics ?? []) {
      let inner = out.get(m.platform)
      if (!inner) {
        inner = new Map()
        out.set(m.platform, inner)
      }
      inner.set(m.metric_type, {
        last_captured_at: m.last_captured_at,
        status_color: m.status_color,
        total_handles: m.total_handles,
        matched_count: m.matched_count,
      })
    }
    return out
  }, [stateData])

  const configByPlatform = useMemo(() => {
    const out = new Map<string, StateConfigRow>()
    for (const c of stateData?.configs ?? []) {
      out.set(c.platform, c)
    }
    return out
  }, [stateData])

  const handleCapture = useCallback(
    (platform: PlatformDef['key'], metricType: string) => {
      // V1: only one combo is live.
      if (platform === 'instagram' && metricType === 'new_followers') {
        setModal({ platform, metricType: 'new_followers' })
      }
    },
    [],
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl text-stone-900">
            Social integration
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-stone-500">
            Instagram, TikTok, Facebook, and Pinterest do not expose the
            data Bloom needs (new followers, profile visits, story
            viewers) via API. Capture the lists once a week and Bloom
            matches them against the couples already in your pipeline.
            Matches whose engagement predates the inquiry are pre-zero
            attribution credit.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full bg-gold-50 px-3 py-1 text-xs text-gold-700">
          <Sparkles className="h-3 w-3" />
          Point-Zero forensic capture
        </div>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {PLATFORMS.map((p) => (
            <PlatformCard
              key={p.key}
              platform={p}
              stateByMetric={stateByPlatformMetric.get(p.key) ?? new Map()}
              onCapture={handleCapture}
            />
          ))}
        </div>
      )}

      {modal ? (
        <CaptureNowModal
          platform={modal.platform}
          metricType={modal.metricType}
          venueHandle={configByPlatform.get('instagram')?.venue_handle ?? null}
          followersUrlOverride={
            configByPlatform.get('instagram')?.followers_url ?? null
          }
          onClose={() => {
            setModal(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}
