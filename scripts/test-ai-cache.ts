/**
 * Unit tests — AI response cache (OPS-21.4.4).
 *
 * Targets:
 *   - aiCacheKey is deterministic over the same input + sensitive
 *     to model / temperature / promptVersion changes (cache busts
 *     correctly when prompt is bumped)
 *   - getCachedAiResponse / setCachedAiResponse hit + expire correctly
 *   - LRU eviction kicks in at MAX_ENTRIES
 *   - withAiCache singleflight: two parallel callers share one loader
 *   - withAiCache ttl: second call after expiry re-runs loader
 */

import {
  aiCacheKey,
  getCachedAiResponse,
  setCachedAiResponse,
  withAiCache,
  __test__,
} from '../src/lib/ai/cache'

let pass = 0
let fail = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    pass++
  } else {
    console.error(`  ✗ ${label}`)
    fail++
  }
}

async function main() {
  console.log('\n=== aiCacheKey ===')
  const baseArgs = {
    systemPrompt: 'You are a helpful assistant.',
    userPrompt: 'Summarise this venue.',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.4,
    promptVersion: 'v1',
  }
  const k1 = aiCacheKey(baseArgs)
  const k2 = aiCacheKey(baseArgs)
  assert(k1 === k2, 'identical inputs → identical key')
  assert(k1.length === 8, 'key is 8-char hex')

  // Sensitivity to each field.
  assert(aiCacheKey({ ...baseArgs, systemPrompt: 'different' }) !== k1, 'systemPrompt change busts key')
  assert(aiCacheKey({ ...baseArgs, userPrompt: 'different' }) !== k1, 'userPrompt change busts key')
  assert(aiCacheKey({ ...baseArgs, model: 'haiku' }) !== k1, 'model change busts key')
  assert(aiCacheKey({ ...baseArgs, temperature: 0.5 }) !== k1, 'temperature change busts key')
  assert(aiCacheKey({ ...baseArgs, promptVersion: 'v2' }) !== k1, 'promptVersion change busts key')

  console.log('\n=== get/set ===')
  __test__.reset()
  assert(getCachedAiResponse<string>('absent') === null, 'missing key → null')
  setCachedAiResponse('a', 'value-a')
  assert(getCachedAiResponse<string>('a') === 'value-a', 'set then get returns value')
  assert(__test__.size() === 1, 'one entry stored')

  // TTL expiry.
  __test__.reset()
  setCachedAiResponse('exp', 'short-lived', 1) // 1ms TTL
  await new Promise((r) => setTimeout(r, 5))
  assert(getCachedAiResponse('exp') === null, 'expired entry returns null + removed')

  console.log('\n=== LRU eviction ===')
  __test__.reset()
  // Fill cache to MAX_ENTRIES and one over.
  for (let i = 0; i < __test__.MAX_ENTRIES; i++) {
    setCachedAiResponse(`k${i}`, i)
  }
  assert(__test__.size() === __test__.MAX_ENTRIES, 'cache at capacity')
  // Touch 'k0' to make it recently used.
  void getCachedAiResponse('k0')
  // Adding one more should evict the oldest non-touched.
  setCachedAiResponse('overflow', 'X')
  assert(__test__.size() === __test__.MAX_ENTRIES, 'capacity preserved after overflow add')
  assert(getCachedAiResponse('k0') === 0, 'recently-touched entry survived eviction')
  assert(getCachedAiResponse('overflow') === 'X', 'newly added entry present')

  console.log('\n=== withAiCache singleflight ===')
  __test__.reset()
  let loaderCalls = 0
  const loader = async () => {
    loaderCalls++
    await new Promise((r) => setTimeout(r, 25))
    return 'computed'
  }
  // Fire 5 parallel callers for the same key.
  const results = await Promise.all([
    withAiCache('sf', loader),
    withAiCache('sf', loader),
    withAiCache('sf', loader),
    withAiCache('sf', loader),
    withAiCache('sf', loader),
  ])
  assert(results.every((r) => r === 'computed'), 'all parallel callers got the same value')
  assert(loaderCalls === 1, `loader called once despite 5 parallel awaits (called ${loaderCalls} times)`)

  // Subsequent serial call hits cache.
  const cached = await withAiCache('sf', loader)
  assert(cached === 'computed', 'cached value returned')
  assert(loaderCalls === 1, 'serial cache hit did not re-invoke loader')

  console.log('\n=== withAiCache TTL re-run ===')
  __test__.reset()
  loaderCalls = 0
  const fastLoader = async () => {
    loaderCalls++
    return `computed-${loaderCalls}`
  }
  const v1 = await withAiCache('ttl', fastLoader, 1) // 1ms TTL
  await new Promise((r) => setTimeout(r, 5))
  const v2 = await withAiCache('ttl', fastLoader, 1)
  assert(v1 === 'computed-1', 'first call computed-1')
  assert(v2 === 'computed-2', 'second call after expiry re-ran loader (computed-2)')
  assert(loaderCalls === 2, 'loader called twice across expiry')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
