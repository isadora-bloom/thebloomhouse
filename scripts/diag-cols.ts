import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
async function cols(t:string){const{data,error}=await sb.from(t).select('*').limit(1);console.log(`\n== ${t} ==`);if(error){console.log('ERR',error.message);return}console.log((data&&data[0]?Object.keys(data[0]):'(no rows)').toString())}
async function main(){for(const t of ['interactions','candidate_identities','attribution_events','discovery_sources']) await cols(t)}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
