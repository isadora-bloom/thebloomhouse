import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'
async function main(){
  const {data}=await sb.from('interactions').select('from_email,subject,timestamp,created_at').eq('venue_id',RIXEY).ilike('from_email','%theknot%').gte('timestamp','2026-05-01').lt('timestamp','2026-06-01').order('timestamp')
  console.log(`DB theknot interactions in MAY 2026: ${data?.length}`)
  const senders=new Set<string>()
  for(const r of (data||[]) as any[]){senders.add(String(r.from_email).replace(/\.reminder/,'').toLowerCase());console.log(`  ${String(r.timestamp).slice(0,10)}  ${String(r.from_email).padEnd(46)} ${String(r.subject).trim().slice(0,40)}`)}
  console.log(`Distinct May Knot senders in DB: ${senders.size}`)
}
main().then(()=>process.exit(0))
