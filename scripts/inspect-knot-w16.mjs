import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
const lines = env.split('\n');
const find = (k) => {
  const line = lines.find(l => l.startsWith(k+'='));
  return line ? line.slice(k.length+1).trim() : '';
};
const url = find('NEXT_PUBLIC_SUPABASE_URL');
const key = find('SUPABASE_SERVICE_ROLE_KEY');

const sb = createClient(url, key);

const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'; // Rixey Manor

const { data: ints, error } = await sb
  .from('interactions')
  .select('id, from_email, subject, body_preview, direction, created_at')
  .eq('venue_id', venueId)
  .or('from_email.ilike.%theknot%,from_email.ilike.%knot.com%')
  .order('created_at', { ascending: false })
  .limit(40);

if (error) {
  console.log('Error:', error.message);
} else {
  console.log(`Found ${ints?.length ?? 0} Knot interactions`);
  for (const i of ints ?? []) {
    console.log('---');
    console.log('from:', i.from_email);
    console.log('subj:', (i.subject || '').slice(0, 120));
    console.log('body:', (i.body_preview || '').slice(0, 500));
  }
}

const { data: ae } = await sb
  .from('attribution_events')
  .select('id, source_platform, role, role_confidence_0_100, decided_at')
  .eq('venue_id', venueId)
  .or('source_platform.ilike.%theknot%,source_platform.ilike.%knot%,source_platform.ilike.%wedding%')
  .limit(100);
console.log('\n--- Knot/WW attribution events ---');
console.log(`count: ${ae?.length ?? 0}`);
if (ae && ae.length > 0) {
  const byPlatformRole = {};
  for (const e of ae) {
    const k = `${e.source_platform}|${e.role || 'null'}`;
    byPlatformRole[k] = (byPlatformRole[k] || 0) + 1;
  }
  console.log('by platform|role:', byPlatformRole);
}

// Also: WeddingWire interactions
const { data: wwInts } = await sb
  .from('interactions')
  .select('id, from_email, subject, body_preview, direction, created_at')
  .eq('venue_id', venueId)
  .or('from_email.ilike.%weddingwire%,from_email.ilike.%wedding-wire%')
  .order('created_at', { ascending: false })
  .limit(15);
console.log(`\n--- WeddingWire interactions: ${wwInts?.length ?? 0} ---`);
for (const i of wwInts ?? []) {
  console.log('---');
  console.log('from:', i.from_email);
  console.log('subj:', (i.subject || '').slice(0, 120));
  console.log('body:', (i.body_preview || '').slice(0, 400));
}
