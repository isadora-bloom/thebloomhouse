import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'

async function page(build:(q:any)=>any){const out:any[]=[];for(let f=0;;f+=1000){let q=sb.from('interactions').select('from_email,subject,full_body,body_preview,timestamp').eq('venue_id',RIXEY).range(f,f+999);q=build(q);const{data,error}=await q;if(error){console.error(error.message);break}if(!data||!data.length)break;out.push(...data);if(data.length<1000)break}return out}

async function main(){
  // GA4 period coverage
  const {data:ga}=await sb.from('website_traffic_history').select('channel_group,sessions,period_start,period_end,created_at').eq('venue_id',RIXEY).order('period_start')
  const periods=new Set((ga||[]).map((r:any)=>`${String(r.period_start).slice(0,10)} → ${String(r.period_end).slice(0,10)}`))
  console.log('GA4 periods covered:',[...periods].join(' | '),' | imported:',String((ga as any)?.[0]?.created_at).slice(0,10))

  // Calendly emails
  const cal=await page(q=>q.ilike('from_email','%calendly%').order('timestamp',{ascending:false}))
  console.log(`\nCalendly interactions: ${cal.length}`)
  // find the "how did you hear" line in bodies
  const re=/(how did you hear[^?\n]*\??|how'd you hear[^?\n]*\??|where did you hear[^?\n]*\??|how did you find[^?\n]*\??)\s*[:\-\n]?\s*([^\n<]{1,80})/i
  const answers:string[]=[]
  let shown=0
  for(const r of cal as any[]){
    const body=String(r.full_body||r.body_preview||'')
    const m=body.match(re)
    if(m){answers.push(m[2].trim())}
  }
  const m=new Map<string,number>(); for(const a of answers){const k=a.toLowerCase().replace(/\s+/g,' ').trim();m.set(k,(m.get(k)??0)+1)}
  console.log(`\n"How did you hear" answers found in Calendly bodies: ${answers.length}`)
  for(const[k,c]of [...m].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(c).padStart(3)}  ${k.slice(0,60)}`)

  // Dump 2 sample bodies so we can see the actual question format
  console.log('\n===== sample Calendly bodies (first 600 chars) =====')
  for(const r of (cal as any[]).slice(0,2)){
    console.log(`\n--- ${String(r.timestamp).slice(0,10)} | ${r.subject?.trim().slice(0,50)} ---`)
    console.log(String(r.full_body||r.body_preview||'(empty)').replace(/\s+/g,' ').slice(0,600))
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
