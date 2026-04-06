// Seed demo data for the REAL Hawthorne Manor venue
const SRK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzeHhnd3ByeHVxZ2NhdXpseGNiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDYzNDQ5MiwiZXhwIjoyMDkwMjEwNDkyfQ.TkgSGTxLe49t6XlCv7_f-2kCTIKWK_iQ-dhTfzNXcro";
const BASE="https://jsxxgwprxuqgcauzlxcb.supabase.co/rest/v1";
const V="22222222-2222-2222-2222-222222222201"; // Real Hawthorne Manor

function db(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString()}
function ds(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().split("T")[0]}
function uuid(n){return "ab000000-0000-0000-0000-"+String(n).padStart(12,"0")}

async function post(table, data) {
  const r = await fetch(new globalThis.URL(table, BASE+"/"), {
    method:"POST",
    headers:{apikey:SRK,Authorization:"Bearer "+SRK,"Content-Type":"application/json",Prefer:"return=minimal,resolution=ignore-duplicates"},
    body:JSON.stringify(data)
  });
  console.log("  "+table+": HTTP "+r.status+(r.ok?"":" "+(await r.text()).slice(0,120)));
}

async function patch(table, filter, data) {
  const r = await fetch(new globalThis.URL(table+"?"+filter, BASE+"/"), {
    method:"PATCH",
    headers:{apikey:SRK,Authorization:"Bearer "+SRK,"Content-Type":"application/json",Prefer:"return=minimal"},
    body:JSON.stringify(data)
  });
  console.log("  "+table+" PATCH: HTTP "+r.status);
}

async function run() {
  console.log("=== Seeding real Hawthorne Manor data ===\n");

  // 1. Venue config
  console.log("1. Venue config...");
  await post("venue_config", {
    venue_id:V, business_name:"Hawthorne Manor",
    primary_color:"#7D8471", secondary_color:"#5D7A7A", accent_color:"#A6894A",
    font_pair:"playfair_inter", timezone:"America/New_York",
    catering_model:"byob", bar_model:"byob", capacity:200, base_price:8500,
    coordinator_name:"Sarah Chen", coordinator_email:"sarah@hawthornemanor.com",
    coordinator_phone:"540-555-0101", portal_tagline:"Where your love story unfolds",
    feature_flags:{
      checklist_template:{tasks:[
        {id:"t1",task_text:"Set your budget",category:"Venue",included:true},
        {id:"t2",task_text:"Book photographer",category:"Vendors",included:true},
        {id:"t3",task_text:"Book videographer",category:"Vendors",included:true},
        {id:"t4",task_text:"Book DJ or band",category:"Vendors",included:true},
        {id:"t5",task_text:"Book hair & makeup",category:"Vendors",included:true},
        {id:"t6",task_text:"Choose caterer",category:"Vendors",included:true},
        {id:"t7",task_text:"Hire florist",category:"Vendors",included:true},
        {id:"t8",task_text:"Send save-the-dates",category:"Guests",included:true},
        {id:"t9",task_text:"Send invitations",category:"Guests",included:true},
        {id:"t10",task_text:"Build day-of timeline",category:"Timeline",included:true},
      ],custom_categories:[]},
      decor_config:{venue_spaces:["Round Guest Tables","Farm Tables","Head Table","Sweetheart Table","Cocktail Tables","Ceremony Arch","Card & Gift Table","Cake Table","Bar Area","Photo Booth","Lounge Area","Porch & Steps"]},
      bar_config:{default_bar_type:"beer-wine",default_guest_count:150}
    }
  });

  // 2. AI config
  console.log("2. AI config...");
  await post("venue_ai_config", {
    venue_id:V, ai_name:"Sage", ai_emoji:"🌿",
    warmth_level:8, formality_level:4, playfulness_level:6,
    brevity_level:3, enthusiasm_level:7, phrase_style:"warm_professional"
  });

  // 3. Weddings (pipeline)
  console.log("3. Weddings...");
  const couples = [
    {id:uuid(1),p1:"Chloe",l1:"Martinez",p2:"Ryan",l2:"Brooks",status:"booked",src:"referral",date:"2026-05-30",heat:95,tier:"hot",bv:12500,inq:db(120)},
    {id:uuid(2),p1:"Emma",l1:"Wright",p2:"Liam",l2:"Chen",status:"booked",src:"the_knot",date:"2026-09-12",heat:90,tier:"hot",bv:9800,inq:db(90)},
    {id:uuid(3),p1:"Sofia",l1:"Patel",p2:"Noah",l2:"Kim",status:"proposal_sent",src:"weddingwire",date:"2026-10-03",heat:72,tier:"warm",bv:11000,inq:db(75)},
    {id:uuid(4),p1:"Mia",l1:"Thompson",p2:"Ethan",l2:"Nguyen",status:"tour_completed",src:"instagram",date:"2027-03-21",heat:80,tier:"hot",bv:null,inq:db(45)},
    {id:uuid(5),p1:"Isabella",l1:"Davis",p2:"Jack",l2:"Wilson",status:"tour_scheduled",src:"referral",date:"2027-04-18",heat:60,tier:"warm",bv:null,inq:db(30)},
    {id:uuid(6),p1:"Olivia",l1:"Garcia",p2:"Ben",l2:"Taylor",status:"inquiry",src:"google",date:"2026-08-22",heat:45,tier:"cool",bv:null,inq:db(20)},
    {id:uuid(7),p1:"Harper",l1:"Lee",p2:"Owen",l2:"Brown",status:"inquiry",src:"the_knot",date:"2027-06-14",heat:55,tier:"warm",bv:null,inq:db(15)},
    {id:uuid(8),p1:"Aria",l1:"Robinson",p2:"Henry",l2:"Thomas",status:"inquiry",src:"website",date:"2027-01-30",heat:40,tier:"cool",bv:null,inq:db(10)},
    {id:uuid(9),p1:"Luna",l1:"Clark",p2:"Aiden",l2:"Jackson",status:"tour_scheduled",src:"referral",date:"2027-05-10",heat:85,tier:"hot",bv:null,inq:db(25)},
    {id:uuid(10),p1:"Zoe",l1:"Hall",p2:"Caleb",l2:"White",status:"booked",src:"the_knot",date:"2026-07-19",heat:92,tier:"hot",bv:10200,inq:db(100)},
    {id:uuid(11),p1:"Ella",l1:"Martinez",p2:"Lucas",l2:"Anderson",status:"lost",src:"weddingwire",date:"2026-12-05",heat:10,tier:"frozen",bv:null,inq:db(60)},
    {id:uuid(12),p1:"Lily",l1:"Allen",p2:"James",l2:"Scott",status:"lost",src:"walk_in",date:null,heat:5,tier:"frozen",bv:null,inq:db(80)},
    // 3 months of older data
    {id:uuid(13),p1:"Grace",l1:"Moore",p2:"Daniel",l2:"Harris",status:"booked",src:"referral",date:"2026-04-12",heat:98,tier:"hot",bv:13500,inq:db(150)},
    {id:uuid(14),p1:"Ava",l1:"Young",p2:"Mason",l2:"King",status:"booked",src:"google",date:"2026-06-07",heat:96,tier:"hot",bv:8900,inq:db(130)},
    {id:uuid(15),p1:"Nora",l1:"Adams",p2:"Leo",l2:"Baker",status:"proposal_sent",src:"instagram",date:"2027-02-14",heat:65,tier:"warm",bv:null,inq:db(55)},
    {id:uuid(16),p1:"Hazel",l1:"Rivera",p2:"Eli",l2:"Cooper",status:"tour_completed",src:"the_knot",date:"2027-07-26",heat:70,tier:"warm",bv:null,inq:db(40)},
  ];

  const weddings = couples.map(c => ({
    id:c.id, venue_id:V, status:c.status, source:c.src,
    wedding_date:c.date, guest_count_estimate:80+Math.floor(Math.random()*120),
    heat_score:c.heat, temperature_tier:c.tier,
    inquiry_date:c.inq, booking_value:c.bv,
  }));
  await post("weddings", weddings);

  const people = [];
  for (const c of couples) {
    people.push(
      {wedding_id:c.id, venue_id:V, first_name:c.p1, last_name:c.l1, role:"partner1", email:c.p1.toLowerCase()+"."+c.l1.toLowerCase()+"@gmail.com"},
      {wedding_id:c.id, venue_id:V, first_name:c.p2, last_name:c.l2, role:"partner2", email:null},
    );
  }
  await post("people", people);

  // 4. Interactions (3 months of inbox)
  console.log("4. Interactions...");
  const interactions = [];
  const subjects = [
    "Availability for September 2026?","Question about catering policy","Tour request — October wedding",
    "Rain plan?","Photo locations on property","Table and chair details",
    "Rehearsal dinner question","Follow up — proposal review","Vendor recommendations",
    "Accommodation options","Weekend availability 2027","Pricing breakdown",
    "ADA accessibility","Instagram inquiry","Dietary accommodations",
    "Day-of coordinator","Pet policy follow-up","Thank you for the tour!",
    "Deposit question","Decor restrictions","Can we bring our own DJ?",
    "Ceremony timing","Guest shuttle options","Sparkler exit rules",
    "How early can vendors arrive?","Tent as rain backup?","Bar setup details",
    "Getting-ready spaces","Reception layout options","Noise ordinance?",
  ];
  const bodies = [
    "Hi! We just got engaged and are looking at venues. Is this date available?",
    "We saw your venue on The Knot and it looks amazing! Could we schedule a visit?",
    "Hello, following up on our conversation last week about pricing and availability.",
    "Quick question about your policies — just want to make sure before we commit.",
    "We loved the tour! Just chatting with family before making our decision.",
  ];

  for (let i = 0; i < 30; i++) {
    const wid = i < couples.length ? couples[i % couples.length].id : couples[i % 8].id;
    interactions.push({
      venue_id:V, wedding_id:wid, type:"email", direction:"inbound",
      subject:subjects[i], body_preview:bodies[i%bodies.length],
      full_body:bodies[i%bodies.length]+" We are expecting about "+(100+i*5)+" guests.",
      timestamp:db(90 - i*3),
    });
    // Reply to some
    if (i < 15) {
      interactions.push({
        venue_id:V, wedding_id:wid, type:"email", direction:"outbound",
        subject:"Re: "+subjects[i],
        body_preview:"Thank you for reaching out! Congratulations on your engagement.",
        full_body:"Thank you for reaching out! Congratulations on your engagement. I would love to tell you more about Hawthorne Manor.",
        timestamp:db(89 - i*3),
      });
    }
  }
  await post("interactions", interactions);

  // 5. Drafts
  console.log("5. Drafts...");
  await post("drafts", [
    {venue_id:V, status:"pending", subject:"Re: Weekend availability 2027", draft_body:"Hi there! Congratulations on your engagement! We have a few Saturdays open in spring 2027 — April 12, April 26, and May 10. Would you like to schedule a tour?",created_at:db(1)},
    {venue_id:V, status:"pending", subject:"Re: Pricing breakdown", draft_body:"Thank you for your interest! Here is our pricing overview:\n\n- Full day venue rental: $8,500\n- Ceremony setup: Included\n- Tables, chairs, basic linens: Included\n- Extra hour: $500/hr\n\nI would love to discuss details during a tour.",created_at:db(1)},
    {venue_id:V, status:"pending", subject:"Re: ADA accessibility", draft_body:"Great question! Our ceremony lawn is fully accessible via a paved pathway. The reception barn has ground-level entry. Restrooms are ADA compliant.",created_at:db(0)},
    {venue_id:V, status:"approved", subject:"Re: Tour request", draft_body:"We would love to have you! I have openings Saturday at 11am and Tuesday at 2pm. The tour takes about 45 minutes.",created_at:db(3)},
    {venue_id:V, status:"sent", subject:"Re: Rain plan?", draft_body:"We have a beautiful covered pavilion seating up to 200 guests with mountain views. We monitor weather closely and coordinate with your vendors.",created_at:db(5)},
    {venue_id:V, status:"sent", subject:"Re: Photo locations", draft_body:"Our top spots: garden gazebo, brick pathway with oak canopy, pond dock, bridal suite balcony, and sunset overlook.",created_at:db(7)},
    {venue_id:V, status:"rejected", subject:"Re: Dietary accommodations", draft_body:"Since we are BYOB for catering...",created_at:db(4)},
  ]);

  // 6. Knowledge base
  console.log("6. Knowledge base...");
  await post("knowledge_base", [
    {venue_id:V,question:"How much does Hawthorne Manor cost?",answer:"Full-day venue rental is $8,500. Includes ceremony + reception spaces, tables, chairs, basic linens, bridal and groom suites, on-site coordinator, and parking.",category:"pricing",keywords:["price","cost","rate","fee"],priority:1,is_active:true},
    {venue_id:V,question:"What is the alcohol/bar policy?",answer:"Hawthorne Manor is BYOB. You supply all beverages. We provide bar setup, glassware, and ice. ABC license required for anything beyond beer & wine.",category:"bar",keywords:["alcohol","byob","bar","drinks"],priority:1,is_active:true},
    {venue_id:V,question:"What is the rain plan?",answer:"Our covered pavilion seats up to 200 guests with mountain views. We monitor weather and coordinate with your vendors to make the call together.",category:"logistics",keywords:["rain","weather","indoor","backup"],priority:1,is_active:true},
    {venue_id:V,question:"How many guests can you hold?",answer:"Up to 200 guests for a seated dinner. Cocktail-style can accommodate up to 250.",category:"capacity",keywords:["capacity","guests","max","how many"],priority:1,is_active:true},
    {venue_id:V,question:"Are there rooms on site?",answer:"Yes! The bridal suite is a renovated farmhouse (room for 10). Groom suite in the barn loft. We also have a relationship with nearby hotels for guest blocks.",category:"accommodation",keywords:["rooms","stay","overnight","hotel"],priority:2,is_active:true},
    {venue_id:V,question:"Are dogs allowed?",answer:"Dogs are welcome for the ceremony! We ask that a designated person take them after. The property has open fields so leashes are required.",category:"pets",keywords:["dogs","pets","animals"],priority:3,is_active:true},
    {venue_id:V,question:"What time does the venue close?",answer:"Music ends at 11 PM. All guests and vendors out by midnight. Extended hours available for $500/hr.",category:"logistics",keywords:["hours","close","curfew","end time"],priority:2,is_active:true},
    {venue_id:V,question:"Do you allow sparkler exits?",answer:"Yes! Use 20-inch sparklers. Designate someone to collect used ones in a metal bucket we provide.",category:"send_off",keywords:["sparklers","exit","send off"],priority:3,is_active:true},
    {venue_id:V,question:"Is there parking?",answer:"100 car spots on property. Overflow in lower field. Shuttle service recommended for 150+ guest weddings.",category:"logistics",keywords:["parking","cars","shuttle"],priority:2,is_active:true},
    {venue_id:V,question:"Do you offer payment plans?",answer:"50% deposit secures your date. Balance due 14 days before wedding. We accept checks, credit cards, and bank transfers.",category:"pricing",keywords:["payment","deposit","plan","installments"],priority:1,is_active:true},
  ]);

  // 7. Trend recommendations
  console.log("7. Recommendations...");
  await post("trend_recommendations", [
    {venue_id:V,recommendation_type:"marketing",title:"Boost Instagram — engagement photo content performing well",body:"Instagram drove 3 inquiries this month (up from 0). Double down with venue walkthrough reels.",data_source:"source_attribution",priority:"high",status:"pending",supporting_data:{inquiries_from_ig:3},applied_at:null,dismissed_at:null},
    {venue_id:V,recommendation_type:"operational",title:"Add Saturday afternoon tour slot",body:"68% of tour requests specify Saturday. Adding a 2pm slot could reduce scheduling friction.",data_source:"tours",priority:"high",status:"applied",supporting_data:{saturday_pct:68,outcome_notes:"Added 2pm — 3 tours booked in first week"},applied_at:db(7),dismissed_at:null},
    {venue_id:V,recommendation_type:"competitive",title:"Highlight BYOB savings in marketing",body:"Competitors charge $45-85/person for bar. Your BYOB model saves couples $6k-12k.",data_source:"market_analysis",priority:"high",status:"pending",supporting_data:{avg_savings:"$9,000"},applied_at:null,dismissed_at:null},
    {venue_id:V,recommendation_type:"pricing",title:"Consider early-bird pricing for Jan-Mar",body:"Winter wedding searches up 23% YoY. Early-bird discount could capture budget-conscious couples.",data_source:"Google Trends",priority:"medium",status:"pending",supporting_data:{trend_change:"+23%"},applied_at:null,dismissed_at:null},
  ]);

  // 8. AI briefings
  console.log("8. Briefings...");
  await post("ai_briefings", [
    {venue_id:V,briefing_type:"weekly",content:{summary:"Strong week. 4 new inquiries (2 Knot, 1 Instagram, 1 referral). Tour with Mia & Ethan went great. 3 hot leads in pipeline. 2 drafts pending approval. Recommendation: add Saturday PM tour slot.",trend_highlights:["Wedding venue searches up 12% WoW"],weather_outlook:"Clear through Saturday"},created_at:db(0)},
    {venue_id:V,briefing_type:"weekly",content:{summary:"2 new inquiries, 1 tour, 1 proposal sent. Chloe & Ryan confirmed booking. Lost: Lily & James chose venue closer to DC. Instagram driving quality leads.",trend_highlights:["Outdoor venue interest peaking"],weather_outlook:"Clear weekend"},created_at:db(7)},
    {venue_id:V,briefing_type:"weekly",content:{summary:"5 new inquiries — highest this quarter. Tour no-show from WeddingWire lead. Two proposals outstanding. Pet policy question recurring — update KB.",trend_highlights:["Virginia wedding costs up 8% YoY"],weather_outlook:"Warm and sunny"},created_at:db(14)},
    {venue_id:V,briefing_type:"monthly",content:{summary:"March: 12 inquiries (up 50% MoM), 4 tours, 2 bookings. Pipeline: $127k in proposals. Instagram 25% of inquiries. Response time averaging 4.2hrs (target: under 2hrs).",metrics:{new_inquiries:12,tours:4,bookings:2},strategic_recommendations:["Invest in Instagram","Reduce response time","Add winter package"]},created_at:db(2)},
  ]);

  // 9. Anomaly alerts
  console.log("9. Alerts...");
  for (const a of [
    {venue_id:V,alert_type:"spike",metric_name:"weekly_inquiries",current_value:8,baseline_value:3.5,change_percent:128,severity:"info",ai_explanation:"Inquiry volume 2x normal. Likely from new Knot photos.",causes:["knot_photo_update"],acknowledged:false},
    {venue_id:V,alert_type:"degradation",metric_name:"response_time_hours",current_value:6.2,baseline_value:3.1,change_percent:100,severity:"warning",ai_explanation:"Response time doubled. 2 inquiries waited 12+ hours.",causes:["high_volume"],acknowledged:false},
    {venue_id:V,alert_type:"decline",metric_name:"pipeline_heat_avg",current_value:38,baseline_value:55,change_percent:-31,severity:"warning",ai_explanation:"3 leads cooling below 30 heat score.",causes:["no_follow_up"],acknowledged:false},
  ]) {
    await post("anomaly_alerts", a);
  }

  // 10. Venue health history (8 weeks)
  console.log("10. Health history...");
  for (let w = 0; w < 8; w++) {
    const j = () => Math.floor(Math.random()*8)-4;
    await post("venue_health", {
      venue_id:V, calculated_at:db(w*7),
      overall_score:82+j(), data_quality_score:95+j(),
      pipeline_score:78+j(), response_time_score:72+j(), booking_rate_score:85+j(),
    });
  }

  // 11. Draft feedback (for learning curve)
  console.log("11. Feedback history...");
  const feedback = [];
  for (let w = 0; w < 12; w++) {
    const weekStart = db(84 - w*7);
    // Early weeks: more edits/rejections. Later weeks: more approvals.
    const approveRate = Math.min(0.95, 0.5 + w * 0.04);
    for (let d = 0; d < 3 + Math.floor(Math.random()*3); d++) {
      const r = Math.random();
      feedback.push({
        venue_id:V, action: r < approveRate ? "approved" : r < approveRate + 0.03 ? "rejected" : "edited",
        created_at: db(84 - w*7 - d),
      });
    }
  }
  await post("draft_feedback", feedback);

  // 12. Search trends (12 weeks)
  console.log("12. Search trends...");
  const trends = [];
  for (const term of ["wedding venues virginia","barn wedding virginia","outdoor wedding culpeper","hawthorne manor wedding","byob wedding venue"]) {
    for (let w = 0; w < 12; w++) {
      trends.push({venue_id:V, metro:"US-VA-584", term, week:ds(w*7), interest:40+Math.floor(Math.random()*50)});
    }
  }
  await post("search_trends", trends);

  // 13. API costs (30 days)
  console.log("13. API costs...");
  const costs = [];
  for (let d = 0; d < 30; d++) {
    costs.push({venue_id:V,service:"draft_generation",model:"claude-sonnet-4-5-20250514",input_tokens:800+Math.floor(Math.random()*400),output_tokens:400+Math.floor(Math.random()*200),cost:0.008+Math.random()*0.004,context:"auto",created_at:db(d)});
    if (d%3===0) costs.push({venue_id:V,service:"extraction",model:"claude-sonnet-4-5-20250514",input_tokens:1200,output_tokens:300,cost:0.006,context:"auto",created_at:db(d)});
    if (d%7===0) costs.push({venue_id:V,service:"weekly_briefing",model:"claude-sonnet-4-5-20250514",input_tokens:3000,output_tokens:1500,cost:0.025,context:"cron",created_at:db(d)});
  }
  await post("api_costs", costs);

  // 14. Source attribution
  console.log("14. Source attribution...");
  await post("source_attribution", [
    {venue_id:V,source:"the_knot",period_start:ds(90),period_end:ds(0),inquiries:8,tours:3,bookings:2,revenue:20000,spend:450},
    {venue_id:V,source:"weddingwire",period_start:ds(90),period_end:ds(0),inquiries:4,tours:1,bookings:0,revenue:0,spend:360},
    {venue_id:V,source:"google",period_start:ds(90),period_end:ds(0),inquiries:3,tours:2,bookings:1,revenue:8900,spend:600},
    {venue_id:V,source:"instagram",period_start:ds(90),period_end:ds(0),inquiries:5,tours:2,bookings:0,revenue:0,spend:150},
    {venue_id:V,source:"referral",period_start:ds(90),period_end:ds(0),inquiries:4,tours:3,bookings:2,revenue:26000,spend:0},
    {venue_id:V,source:"website",period_start:ds(90),period_end:ds(0),inquiries:2,tours:1,bookings:1,revenue:10200,spend:0},
  ]);

  // 15. Wedding-specific couple data for Chloe & Ryan (first wedding)
  const W = uuid(1);
  console.log("15. Couple portal data (Chloe & Ryan)...");

  await post("wedding_details", {venue_id:V, wedding_id:W, wedding_colors:"Dusty rose, sage green, ivory", dogs_coming:true, dogs_description:"Golden retriever Biscuit — ceremony only", ceremony_location:"outside", arbor_choice:"Wooden arch with floral swag", unity_table:true, send_off_type:"sparklers"});

  await post("wedding_config", {venue_id:V, wedding_id:W, total_budget:40000, budget_shared:true, plated_meal:true});

  await post("budget_items", [
    {venue_id:V,wedding_id:W,category:"Venue",item_name:"Venue rental",budgeted:8500,committed:8500,paid:4250,vendor_name:"Hawthorne Manor",sort_order:1},
    {venue_id:V,wedding_id:W,category:"Photography",item_name:"Photography",budgeted:4200,committed:4200,paid:1000,vendor_name:"Hannah Kate Photography",sort_order:2},
    {venue_id:V,wedding_id:W,category:"Catering",item_name:"Dinner + cocktail",budgeted:8500,committed:8500,paid:2000,vendor_name:"Wildflower Catering",sort_order:3},
    {venue_id:V,wedding_id:W,category:"Flowers",item_name:"Floral package",budgeted:3200,committed:3200,paid:800,vendor_name:"Stems & Soil",sort_order:4},
    {venue_id:V,wedding_id:W,category:"Music",item_name:"DJ services",budgeted:1800,committed:1800,paid:500,vendor_name:"Blue Ridge Beats",sort_order:5},
    {venue_id:V,wedding_id:W,category:"Beauty",item_name:"Hair & makeup",budgeted:1400,committed:1400,paid:350,vendor_name:"Glow Beauty Studio",sort_order:6},
  ]);

  // Also update the hardcoded WEDDING_ID in couple pages
  console.log("\n  NOTE: Update WEDDING_ID in couple pages to: " + W);

  console.log("\n=== Done! ===");
}

run().catch(e => console.error(e));
