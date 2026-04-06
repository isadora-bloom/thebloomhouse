// Fix seed for tables that had column mismatches
const SRK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzeHhnd3ByeHVxZ2NhdXpseGNiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDYzNDQ5MiwiZXhwIjoyMDkwMjEwNDkyfQ.TkgSGTxLe49t6XlCv7_f-2kCTIKWK_iQ-dhTfzNXcro";
const BASE="https://jsxxgwprxuqgcauzlxcb.supabase.co/rest/v1";
const V="22222222-2222-2222-2222-222222222201";

function daysBefore(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString(); }
function dateStr(daysAgo){ const d=new Date(); d.setDate(d.getDate()-daysAgo); return d.toISOString().split("T")[0]; }

async function post(table, data) {
  const r = await fetch(new globalThis.URL(table, BASE+"/"), {
    method:"POST",
    headers:{apikey:SRK,Authorization:"Bearer "+SRK,"Content-Type":"application/json",Prefer:"return=minimal,resolution=ignore-duplicates"},
    body:JSON.stringify(data)
  });
  const ok = r.ok ? "" : " — "+(await r.text()).slice(0,150);
  console.log("  "+table+": HTTP "+r.status+ok);
}

async function run() {
  console.log("=== Fixing failed seeds ===\n");

  // intelligence_extractions: cols are extraction_type, value, confidence
  console.log("1. Intelligence extractions...");
  const extractions = [
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",interaction_id:null,extraction_type:"budget_range",value:"$30k-40k",confidence:0.85,created_at:daysBefore(40)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",interaction_id:null,extraction_type:"guest_count",value:"130",confidence:0.95,created_at:daysBefore(40)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",interaction_id:null,extraction_type:"competing_venues",value:"Early Mountain Vineyards, Pippin Hill",confidence:0.8,created_at:daysBefore(40)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",interaction_id:null,extraction_type:"communication_style",value:"enthusiastic",confidence:0.9,created_at:daysBefore(40)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000201",interaction_id:null,extraction_type:"budget_range",value:"$25k-35k",confidence:0.8,created_at:daysBefore(35)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000201",interaction_id:null,extraction_type:"pain_points",value:"catering flexibility",confidence:0.75,created_at:daysBefore(35)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000201",interaction_id:null,extraction_type:"phone_number",value:"434-555-9901",confidence:1.0,created_at:daysBefore(35)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",interaction_id:null,extraction_type:"budget_range",value:"$40k-50k",confidence:0.85,created_at:daysBefore(25)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",interaction_id:null,extraction_type:"guest_count",value:"180",confidence:0.9,created_at:daysBefore(25)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",interaction_id:null,extraction_type:"competing_venues",value:"The Inn at Willow Grove, Keswick Hall",confidence:0.85,created_at:daysBefore(25)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",interaction_id:null,extraction_type:"budget_range",value:"$50k+",confidence:0.9,created_at:daysBefore(10)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",interaction_id:null,extraction_type:"communication_style",value:"decisive, ready to book",confidence:0.95,created_at:daysBefore(10)},
  ];
  await post("intelligence_extractions", extractions);

  // knowledge_base: cols are category, question, answer, keywords, priority, is_active
  console.log("2. Knowledge base...");
  const kb = [
    {venue_id:V,question:"What is the alcohol policy?",answer:"Rixey Manor is BYOB. You supply all beverages. We provide the bar setup, glassware, and ice. An ABC license is required for anything beyond beer and wine.",category:"bar",keywords:["alcohol","byob","bar","drinks","liquor"],priority:1,is_active:true},
    {venue_id:V,question:"What time does the venue close?",answer:"Music must end by 11:00 PM. All vendors and guests must vacate by midnight. We offer extended hours until midnight for an additional $500.",category:"logistics",keywords:["hours","close","curfew","noise","end time"],priority:2,is_active:true},
    {venue_id:V,question:"Is there a getting-ready space?",answer:"Yes! The bridal suite is a beautifully renovated farmhouse with a full-length mirror, natural light, and room for up to 10 people. The groom suite is in the barn loft.",category:"spaces",keywords:["getting ready","bridal suite","groom suite","prep"],priority:3,is_active:true},
    {venue_id:V,question:"Can we have a live band?",answer:"Absolutely! We have full power available in the barn and on the lawn. Sound levels should be reasonable after 10 PM per Culpeper County ordinance.",category:"entertainment",keywords:["band","music","live","acoustic","sound"],priority:4,is_active:true},
    {venue_id:V,question:"Do you allow sparkler exits?",answer:"Yes! Sparkler exits are one of our most popular send-offs. We ask that you use 20-inch sparklers and designate someone to collect used sparklers in a metal bucket.",category:"send_off",keywords:["sparklers","exit","send off","farewell"],priority:5,is_active:true},
    {venue_id:V,question:"Is there parking on site?",answer:"We have parking for up to 100 cars on the property. For larger weddings, we recommend shuttle service from nearby hotels. Overflow parking is available in the lower field.",category:"logistics",keywords:["parking","cars","shuttle","transportation"],priority:2,is_active:true},
    {venue_id:V,question:"Can we do a first look on the property?",answer:"Of course! The garden gazebo and the oak pathway are both popular first-look spots. We will make sure the area is clear and private during your scheduled time.",category:"ceremony",keywords:["first look","photos","private","gazebo"],priority:4,is_active:true},
    {venue_id:V,question:"What is included in the rental?",answer:"Full-day access (10am-midnight), ceremony and reception spaces, tables and chairs, basic ivory linens, bridal and groom suites, setup/breakdown time, on-site coordinator, and parking.",category:"pricing",keywords:["included","rental","package","what comes with"],priority:1,is_active:true},
    {venue_id:V,question:"Do you offer payment plans?",answer:"Yes. We require a 50% deposit to secure your date, with the remaining balance due 14 days before the wedding. We accept checks, credit cards, and bank transfers.",category:"pricing",keywords:["payment","deposit","plan","installments","credit card"],priority:1,is_active:true},
    {venue_id:V,question:"What is your rain plan?",answer:"We have a beautiful covered pavilion that seats up to 200 guests with mountain views. We monitor weather closely the week of each wedding and coordinate with your vendors.",category:"logistics",keywords:["rain","weather","indoor","backup","plan b"],priority:1,is_active:true},
  ];
  await post("knowledge_base", kb);

  // search_trends: cols are metro, term, week, interest
  console.log("3. Search trends...");
  const trendKeywords = ["wedding venues virginia","barn wedding virginia","outdoor wedding venue","wedding venue culpeper","rixey manor wedding"];
  const trends = [];
  for (const kw of trendKeywords) {
    for (let week = 0; week < 12; week++) {
      trends.push({venue_id:V, metro:"US-VA-584", term:kw, week:dateStr(week*7), interest:40+Math.floor(Math.random()*50)});
    }
  }
  await post("search_trends", trends);

  // api_costs: cols are service, model, input_tokens, output_tokens, cost, context
  console.log("4. API costs...");
  const costs = [];
  for (let d = 0; d < 30; d++) {
    costs.push({venue_id:V,service:"draft_generation",model:"claude-sonnet-4-5-20250514",input_tokens:800+Math.floor(Math.random()*400),output_tokens:400+Math.floor(Math.random()*200),cost:0.008+Math.random()*0.004,context:"auto",created_at:daysBefore(d)});
    if (d%3===0) costs.push({venue_id:V,service:"extraction",model:"claude-sonnet-4-5-20250514",input_tokens:1200,output_tokens:300,cost:0.006,context:"auto",created_at:daysBefore(d)});
    if (d%7===0) costs.push({venue_id:V,service:"weekly_briefing",model:"claude-sonnet-4-5-20250514",input_tokens:3000,output_tokens:1500,cost:0.025,context:"cron",created_at:daysBefore(d)});
  }
  await post("api_costs", costs);

  // lead_score_history: cols are score, temperature_tier, calculated_at
  console.log("5. Lead score history...");
  const couples = [
    ["44444444-4444-4444-4444-444444000200",85,"hot"],
    ["44444444-4444-4444-4444-444444000201",72,"warm"],
    ["44444444-4444-4444-4444-444444000202",45,"cool"],
    ["44444444-4444-4444-4444-444444000203",90,"hot"],
    ["44444444-4444-4444-4444-444444000204",60,"warm"],
    ["44444444-4444-4444-4444-444444000205",35,"cool"],
  ];
  const scoreHistory = [];
  for (const [wid,base,tier] of couples) {
    for (let w=0; w<6; w++) {
      const score = Math.max(0,Math.min(100, base-10+w*3+Math.floor(Math.random()*10)));
      const t = score>70?"hot":score>40?"warm":score>20?"cool":"cold";
      scoreHistory.push({venue_id:V,wedding_id:wid,score,temperature_tier:t,calculated_at:daysBefore(35-w*7)});
    }
  }
  await post("lead_score_history", scoreHistory);

  // natural_language_queries: cols are query_text, response_text, model_used, tokens_used, cost, helpful
  console.log("6. NLQ history...");
  const nlqs = [
    {venue_id:V,user_id:null,query_text:"How many inquiries did we get this month?",response_text:"You received 12 new inquiries in March 2026, up 50% from February. Top sources: The Knot (5), Instagram (3), Referrals (2).",model_used:"claude-sonnet-4-5-20250514",tokens_used:450,cost:0.003,helpful:true,created_at:daysBefore(3)},
    {venue_id:V,user_id:null,query_text:"Which lead source has the best conversion rate?",response_text:"Referrals have the highest conversion rate at 50% (2 bookings from 4 inquiries). The Knot is second at 20%.",model_used:"claude-sonnet-4-5-20250514",tokens_used:380,cost:0.003,helpful:true,created_at:daysBefore(5)},
    {venue_id:V,user_id:null,query_text:"What is our average booking value?",response_text:"Your average booking value across confirmed weddings is $10,167.",model_used:"claude-sonnet-4-5-20250514",tokens_used:320,cost:0.002,helpful:true,created_at:daysBefore(8)},
    {venue_id:V,user_id:null,query_text:"Show me leads that are going cold",response_text:"3 leads have dropped below 30 heat score: Ava & Mason (28), Olivia & Ben (18), Ella & Lucas (12).",model_used:"claude-sonnet-4-5-20250514",tokens_used:400,cost:0.003,helpful:true,created_at:daysBefore(1)},
    {venue_id:V,user_id:null,query_text:"What do couples ask about most?",response_text:"Top 5: Pricing (35%), Catering/BYOB (22%), Rain plan (15%), Capacity (12%), Accommodation (10%).",model_used:"claude-sonnet-4-5-20250514",tokens_used:350,cost:0.003,helpful:null,created_at:daysBefore(12)},
  ];
  await post("natural_language_queries", nlqs);

  // anomaly_alerts: cols are alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged
  console.log("7. Anomaly alerts...");
  const alerts = [
    {venue_id:V,alert_type:"spike",metric_name:"weekly_inquiries",current_value:8,baseline_value:3.5,change_percent:128,severity:"info",ai_explanation:"Inquiry volume 2x normal this week. Likely driven by new Knot listing photos uploaded last Monday.",causes:["knot_photo_update"],acknowledged:false,created_at:daysBefore(2)},
    {venue_id:V,alert_type:"degradation",metric_name:"response_time_hours",current_value:6.2,baseline_value:3.1,change_percent:100,severity:"warning",ai_explanation:"Mean first-response time doubled to 6.2 hours. 2 inquiries waited over 12 hours. May be impacting conversion.",causes:["high_volume","coordinator_pto"],acknowledged:false,created_at:daysBefore(1)},
    {venue_id:V,alert_type:"decline",metric_name:"pipeline_heat_avg",current_value:38,baseline_value:55,change_percent:-31,severity:"warning",ai_explanation:"3 leads cooling rapidly: Ava & Mason, Olivia & Ben, Ella & Lucas have all dropped below 30. Consider re-engagement.",causes:["no_follow_up"],acknowledged:false,created_at:daysBefore(3)},
    {venue_id:V,alert_type:"competitor",metric_name:"competitor_mentions",current_value:2,baseline_value:0,change_percent:200,severity:"info",ai_explanation:"Pippin Hill Farm mentioned by 2 separate inquiry couples. Both cited outdoor ceremony options. Ensure outdoor spaces featured in responses.",causes:["competitive_pressure"],acknowledged:true,acknowledged_by:"Sarah Chen",created_at:daysBefore(10)},
    {venue_id:V,alert_type:"spike",metric_name:"instagram_referrals",current_value:3,baseline_value:0.5,change_percent:500,severity:"info",ai_explanation:"Instagram referrals surged to 3 this month (from avg 0.5). Recent reel featuring sunset ceremony got 12K views.",causes:["viral_content"],acknowledged:true,acknowledged_by:"Sarah Chen",created_at:daysBefore(15)},
  ];
  await post("anomaly_alerts", alerts);

  // trend_recommendations: ensure all keys match (the resolved_at issue)
  console.log("8. Trend recommendations...");
  const recs = [
    {venue_id:V,recommendation_type:"pricing",title:"Consider early-bird pricing for January-March dates",body:"Winter wedding searches up 23% YoY in Virginia. An early-bird discount could capture budget-conscious couples.",data_source:"Google Trends",priority:"medium",status:"pending",supporting_data:{trend_change:"+23%"},applied_at:null,dismissed_at:null},
    {venue_id:V,recommendation_type:"marketing",title:"Boost Instagram presence with engagement photo content",body:"Instagram referrals generated 3 inquiries this month (up from 0). Double down with venue walkthrough reels.",data_source:"source_attribution",priority:"high",status:"pending",supporting_data:{inquiries_from_ig:3},applied_at:null,dismissed_at:null},
    {venue_id:V,recommendation_type:"operational",title:"Add Saturday afternoon tour slots",body:"68% of tour requests specify Saturday. Adding a 2pm slot could reduce scheduling friction.",data_source:"tours",priority:"high",status:"applied",supporting_data:{saturday_pct:68,outcome_notes:"Added 2pm slot, booked 3 tours in first week"},applied_at:daysBefore(7),dismissed_at:null},
    {venue_id:V,recommendation_type:"content",title:"Update website gallery with fall foliage shots",body:"Fall wedding searches peak in August. Current gallery has no autumn imagery.",data_source:"Google Trends",priority:"medium",status:"applied",supporting_data:{outcome_notes:"Styled shoot booked Oct 5 with Hannah Kate"},applied_at:daysBefore(14),dismissed_at:null},
    {venue_id:V,recommendation_type:"competitive",title:"Highlight BYOB savings advantage in marketing",body:"Competing venues charge $45-85/person for bar. Your BYOB model saves couples $6k-12k. Rarely mentioned in marketing.",data_source:"market_analysis",priority:"high",status:"pending",supporting_data:{competitor_bar_cost:"$45-85/pp",avg_savings:"$9,000"},applied_at:null,dismissed_at:null},
    {venue_id:V,recommendation_type:"weather",title:"Prepare rain-plan talking points for June tours",body:"NOAA forecasts above-average rainfall for June 2026. Tours should proactively address covered pavilion.",data_source:"NOAA",priority:"low",status:"dismissed",supporting_data:{rain_probability:"above_average"},applied_at:null,dismissed_at:daysBefore(10)},
  ];
  await post("trend_recommendations", recs);

  console.log("\n=== Fix seed complete! ===");
}
run().catch(e=>console.error(e));
