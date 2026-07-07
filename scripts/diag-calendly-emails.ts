import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'
async function show(label:string,q:any){const{data,error}=await q;console.log(`\n############ ${label} (${data?.length||0})${error?' ERR '+error.message:''} ############`)
  for(const r of data||[]){console.log('\n--- subj:',r.subject,'| from:',r.from_email,'|',String(r.timestamp).slice(0,10));console.log(String(r.full_body||r.body_preview||'').replace(/\r/g,'').replace(/\n{2,}/g,'\n').slice(0,1100))}}
async function main(){
  await show('from calendly', sb.from('interactions').select('subject,from_email,timestamp,full_body,body_preview').eq('venue_id',RIXEY).ilike('from_email','%calendly%').order('timestamp',{ascending:false}).limit(3))
  await show('subject New Event', sb.from('interactions').select('subject,from_email,timestamp,full_body,body_preview').eq('venue_id',RIXEY).ilike('subject','%New Event%').order('timestamp',{ascending:false}).limit(3))
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
