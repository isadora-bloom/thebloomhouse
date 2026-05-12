/**
 * Vision-extraction prompt builder for social-engagement screenshots.
 *
 * Single system prompt across all platforms (Instagram, TikTok, Facebook,
 * Pinterest). Parametrized by `{platform, metric_type}` so the model knows
 * what view it's looking at + what shape of row to extract.
 *
 * Output contract: a JSON array of structured rows. Date back-derivation
 * happens downstream in `date-parser.ts` (checkpoint 4) — the model just
 * emits the relative_age string as it appears in the screenshot.
 */

export const SOCIAL_VISION_PROMPT_VERSION = 'social-vision-extract.v1'

export type SocialPlatform = 'instagram' | 'tiktok' | 'facebook' | 'pinterest'

export type SocialMetricType =
  | 'new_followers'
  | 'profile_visits'
  | 'story_views'
  | 'post_engagement'
  | 'dms'
  | 'video_engagement'
  | 'page_likes'
  | 'saves'
  | 'board_follows'

export interface SocialVisionRow {
  /** Lowercased platform handle. NO leading @. e.g. "crystalimagephoto". */
  handle: string
  /** Display name if shown alongside the handle. Often null. */
  display_name?: string | null
  /** What the row says happened. Free-text, normalized. e.g.
   *  'started_following', 'liked_post', 'saved_pin', 'commented',
   *  'mentioned', 'viewed_story'. */
  action: string
  /** EXACTLY as shown. e.g. "2d", "1w", "May 04", "Mar 2026", "now".
   *  null when no timestamp is visible in the row. */
  relative_age: string | null
  /** Reciprocal-relationship indicator visible on the row. e.g. "Follow Back"
   *  button → status='not_following_back'; "Following" button → 'mutual';
   *  "Friends" / "Connected" → 'mutual'. null when no button is shown. */
  status?: 'mutual' | 'not_following_back' | null
}

const PLATFORM_HINTS: Record<SocialPlatform, string> = {
  instagram:
    'Instagram screenshots usually show: small circular profile pic on the left, ' +
    'handle in bold, action text ("started following you" / "liked your post" / ' +
    '"commented" / "mentioned you"), a relative timestamp ("2d", "1w", "May 04"), ' +
    'and an action button on the right ("Follow Back" or "Following"). ' +
    'Handles never include spaces or "@" (the "@" in display is ornamental). ' +
    'Handles can include letters, digits, periods, underscores. Filter out UI ' +
    'tabs (All, People you follow, Comments, Follows) and the screen title.',
  tiktok:
    'TikTok screenshots usually show: square profile pic, @handle in bold (with ' +
    'a real "@" prefix in display), display name underneath, action text ' +
    '("Started following you" / "Liked your video"), and a "Follow Back" or ' +
    '"Following" button. Strip the leading "@" when emitting the handle.',
  facebook:
    'Facebook screenshots usually show: round profile pic, full real name (not ' +
    'a handle — Facebook treats display names as primary identity), action ' +
    '("liked your post" / "follows you"), relative timestamp. The "handle" field ' +
    'in your output for Facebook should be the lowercased space-stripped name ' +
    '(e.g. "Sarah Wilson" → "sarah_wilson") and display_name carries the real ' +
    'rendered name. This is the Facebook-only convention.',
  pinterest:
    'Pinterest screenshots usually show: profile pic, username (no @), display ' +
    'name, action ("saved your pin" / "followed your board"), and the affected ' +
    'pin or board name. Emit pin/board names in the display_name field when ' +
    'shown.',
}

const METRIC_HINTS: Record<SocialMetricType, string> = {
  new_followers:
    'Each row is a person who recently started following the venue. action is ' +
    'always "started_following". Focus only on follow-class rows; skip likes, ' +
    'comments, mentions, story views.',
  profile_visits:
    'Each row is a profile-visit event. action is "viewed_profile". May or ' +
    'may not include a button; status will usually be null.',
  story_views:
    'Each row is a story view. action is "viewed_story". The story or post ' +
    'title (if visible) goes in display_name.',
  post_engagement:
    'Each row is a like / comment / save on a post. action one of "liked_post", ' +
    '"commented", "saved_post". Post id or thumbnail caption (if visible) into ' +
    'display_name.',
  dms:
    'Each row is a direct message thread. action="messaged". Preview text into ' +
    'display_name (truncated to 100 chars).',
  video_engagement:
    'TikTok video interactions. action one of "liked_video", "commented_video".',
  page_likes:
    'Facebook page-like events. action="page_like".',
  saves:
    'Pinterest save events. action="saved_pin". Pin name into display_name.',
  board_follows:
    'Pinterest board-follow events. action="board_follow". Board name into ' +
    'display_name.',
}

export function buildSocialVisionSystemPrompt(): string {
  return [
    'You extract structured rows from a screenshot of a social-media engagement ',
    'list (notifications, followers, likes, saves, etc).',
    '',
    'Return ONLY a JSON array. No prose, no markdown, no leading text. Just the ',
    'array. Each element must match this shape exactly:',
    '',
    '  {',
    '    "handle": string,            // required, lowercase, no leading @',
    '    "display_name": string|null, // optional',
    '    "action": string,            // required, snake_case verb',
    '    "relative_age": string|null, // exactly as shown ("2d", "May 04", null)',
    '    "status": "mutual"|"not_following_back"|null',
    '  }',
    '',
    'If a row has no visible handle (e.g. a UI tab, the screen header, an empty ',
    'state), SKIP it. Do not invent rows or hallucinate dates that are not on ',
    'screen. If you are unsure about a handle reading, skip it rather than ',
    'guess. Output an empty array `[]` if nothing extractable is visible.',
    '',
    'Handle hygiene: lowercase, strip leading "@", strip trailing whitespace, ',
    'no spaces within. If two rows share the same handle, emit each occurrence ',
    'separately (downstream code dedups by handle within a capture).',
  ].join('\n')
}

export function buildSocialVisionUserPrompt(args: {
  platform: SocialPlatform
  metricType: SocialMetricType
}): string {
  const platformHint = PLATFORM_HINTS[args.platform]
  const metricHint = METRIC_HINTS[args.metricType] ?? ''
  return [
    `Platform: ${args.platform}`,
    `Metric: ${args.metricType}`,
    '',
    'Platform shape hint:',
    platformHint,
    '',
    'Metric shape hint:',
    metricHint,
    '',
    'Extract the rows now and emit the JSON array.',
  ].join('\n')
}
