// Where are website visitors coming from (pixel + GA4) and what do couples say in Calendly?
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const RIXEY='f3d10226-4c5c-47ad-b89b-98ad63842492'
const ym=(d:any)=>d?String(d).slice(0,7):'(none)'
const host=(u:string)=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return u?String(u).slice(0,40):'(direct/none)'}}
function tally(rows:any[],key:(r:any)=>string){const m=new Map<string,number>();for(const r of rows){const k=key(r)||'(none)';m.set(k,(m.get(k)??0)+1)}return [...m].sort((a,b)=>b[1]-a[1])}

async function page(tbl:string,sel:string,build:(q:any)=>any){const out:any[]=[];for(let f=0;;f+=1000){let q=sb.from(tbl).select(sel).eq('venue_id',RIXEY).range(f,f+999);q=build(q);const{data,error}=await q;if(error){console.error(tbl,error.message);break}if(!data||!data.length)break;out.push(...data);if(data.length<1000)break}return out}

async function main(){
  // ---------- 1. WEB PIXEL (web_visits) ----------
  const visits=await page('web_visits','utm_source,utm_medium,utm_campaign,gclid,fbclid,ttclid,msclkid,referrer,landing_path,occurred_at',q=>q.order('occurred_at',{ascending:true}))
  console.log(`\n#################### WEB PIXEL (web_visits): ${visits.length} total ####################`)
  if(visits.length){
    const byMonth=tally(visits,r=>ym(r.occurred_at))
    console.log('\nVisits per month:'); for(const[m,c]of byMonth.sort((a,b)=>a[0].localeCompare(b[0]))) console.log(`  ${m}  ${c}`)
    console.log('\nTop referrer hosts:'); for(const[k,c]of tally(visits,r=>host(r.referrer)).slice(0,15)) console.log(`  ${String(k).padEnd(34)} ${c}`)
    console.log('\nutm_source:'); for(const[k,c]of tally(visits,r=>r.utm_source).slice(0,15)) console.log(`  ${String(k).padEnd(24)} ${c}`)
    console.log('\nutm_medium:'); for(const[k,c]of tally(visits,r=>r.utm_medium).slice(0,15)) console.log(`  ${String(k).padEnd(24)} ${c}`)
    console.log('\nutm_campaign:'); for(const[k,c]of tally(visits,r=>r.utm_campaign).slice(0,12)) console.log(`  ${String(k).padEnd(28)} ${c}`)
    const paid=visits.filter(r=>r.gclid||r.fbclid||r.ttclid||r.msclkid)
    console.log(`\nPaid-ad click-throughs (any click id): ${paid.length}  (google ${visits.filter(r=>r.gclid).length} / fb ${visits.filter(r=>r.fbclid).length} / tiktok ${visits.filter(r=>r.ttclid).length} / bing ${visits.filter(r=>r.msclkid).length})`)
    console.log('\nTop landing paths:'); for(const[k,c]of tally(visits,r=>r.landing_path).slice(0,12)) console.log(`  ${String(k).padEnd(34)} ${c}`)
  } else console.log('  (pixel has logged ZERO visits — not deployed / not firing on the live site)')

  // ---------- 2. GA4 channel groups (website_traffic_history) ----------
  const ga=await page('website_traffic_history','channel_group,sessions,engaged_sessions,key_events,period_start,period_end,created_at',q=>q)
  console.log(`\n#################### GA4 website_traffic_history: ${ga.length} rows ####################`)
  if(ga.length){
    const byCh=new Map<string,{s:number,e:number,k:number}>()
    for(const r of ga as any[]){const e=byCh.get(r.channel_group)??{s:0,e:0,k:0};e.s+=r.sessions||0;e.e+=r.engaged_sessions||0;e.k+=r.key_events||0;byCh.set(r.channel_group,e)}
    console.log('channel_group           sessions  engaged  key_events')
    for(const[k,v]of [...byCh].sort((a,b)=>b[1].s-a[1].s)) console.log(`  ${k.padEnd(22)} ${String(v.s).padEnd(9)} ${String(v.e).padEnd(8)} ${v.k}`)
    const r0:any=ga[0]; console.log('sample row keys:',Object.keys(r0).join(', '))
  } else console.log('  (no GA4 rows)')

  // ---------- 3. CALENDLY "how did you hear" ----------
  const wed=await page('weddings','id,calendly_qa,source,inquiry_date',q=>q.not('calendly_qa','is',null))
  console.log(`\n#################### CALENDLY Q&A: ${wed.length} weddings have calendly_qa ####################`)
  const heardAnswers:string[]=[]; const allQ=new Set<string>()
  for(const w of wed as any[]){
    let qa=w.calendly_qa; if(typeof qa==='string'){try{qa=JSON.parse(qa)}catch{}}
    const pairs:Array<{q:string,a:string}>=[]
    if(Array.isArray(qa)) for(const it of qa){const q=it.question??it.q??it.label??''; const a=it.answer??it.a??it.value??''; pairs.push({q:String(q),a:String(a)})}
    else if(qa&&typeof qa==='object') for(const[q,a]of Object.entries(qa)) pairs.push({q:String(q),a:String(a)})
    for(const p of pairs){ allQ.add(p.q)
      if(/hear|find|found|refer|source|how did/i.test(p.q)&&p.a&&p.a!=='undefined') heardAnswers.push(p.a.trim()) }
  }
  console.log('\nDistinct Calendly questions seen:'); for(const q of allQ) console.log(`  • ${q.slice(0,80)}`)
  console.log(`\n"How did you hear about us" answers (${heardAnswers.length}):`)
  for(const[k,c]of tally(heardAnswers.map(a=>({a})),r=>r.a.toLowerCase())) console.log(`  ${String(c).padStart(3)}  ${k.slice(0,60)}`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
