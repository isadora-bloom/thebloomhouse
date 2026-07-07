import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'
async function main(){
  const {data}=await sb.from('interactions').select('from_email,subject,timestamp').eq('venue_id',RIXEY).ilike('from_email','%theknot%').gte('timestamp','2026-05-25').order('timestamp')
  console.log(`DB theknot interactions since May 25: ${data?.length}`)
  for(const r of (data||[]) as any[]) console.log(`  ${String(r.timestamp).slice(0,10)}  ${String(r.from_email).split('@')[0].padEnd(34)} ${String(r.subject).trim().slice(0,38)}`)
}
main().then(()=>process.exit(0))
