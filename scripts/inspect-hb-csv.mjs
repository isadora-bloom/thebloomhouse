import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const path = 'f3d10226-4c5c-47ad-b89b-98ad63842492/97dee45d-b135-48ed-bdc5-847b4ccd835c-January-2025-March-2026-Booked_Client-report-_HoneyBook_.csv'
const { data, error } = await sb.storage.from('brain-dump').download(path)
if (error) { console.error('error', error); process.exit(1) }
const text = await data.text()
const lines = text.split('\n')
console.log('--- HEADER ---')
console.log(lines[0])
console.log('--- First 3 data rows ---')
for (const l of lines.slice(1, 4)) console.log(l)
console.log('--- Total rows ---', lines.length - 1)
