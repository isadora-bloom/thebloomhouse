import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'
async function c(t:string,build:(q:any)=>any=q=>q){const{count,error}=await build(sb.from(t).select('id',{count:'exact',head:true}).eq('venue_id',RIXEY));return error?`ERR ${error.message}`:count}
async function main(){
  console.log('weddings total                :',await c('weddings'))
  console.log('discovery_sources rows        :',await c('discovery_sources'))
  console.log('attribution_events rows       :',await c('attribution_events'))
  console.log('attribution_events first_touch:',await c('attribution_events',q=>q.eq('is_first_touch',true)))
  console.log('candidate_identities rows     :',await c('candidate_identities'))
  console.log('cand_id source=web/website    :',await c('candidate_identities',q=>q.in('source_platform',['web','website','web_form','pixel'])))
  // discovery_sources canonical breakdown
  const{data:ds}=await sb.from('discovery_sources').select('canonical_source,capture_source').eq('venue_id',RIXEY).limit(2000)
  const m=new Map<string,number>();for(const r of ds||[]){const k=`${r.capture_source}/${r.canonical_source}`;m.set(k,(m.get(k)||0)+1)}
  console.log('\ndiscovery_sources by capture/canonical:');for(const[k,v]of[...m].sort((a,b)=>b[1]-a[1]))console.log('  ',k,v)
  // candidate source platforms
  const{data:ci}=await sb.from('candidate_identities').select('source_platform').eq('venue_id',RIXEY).limit(5000)
  const cm=new Map<string,number>();for(const r of ci||[]){cm.set(r.source_platform,(cm.get(r.source_platform)||0)+1)}
  console.log('\ncandidate_identities by source_platform:');for(const[k,v]of[...cm].sort((a,b)=>b[1]-a[1]))console.log('  ',k,v)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
