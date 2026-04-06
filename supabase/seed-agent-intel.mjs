// Bulk seed for Agent + Intelligence tables
// Run: node supabase/seed-agent-intel.mjs

const SRK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzeHhnd3ByeHVxZ2NhdXpseGNiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDYzNDQ5MiwiZXhwIjoyMDkwMjEwNDkyfQ.TkgSGTxLe49t6XlCv7_f-2kCTIKWK_iQ-dhTfzNXcro";
const BASE="https://jsxxgwprxuqgcauzlxcb.supabase.co/rest/v1";
const V="22222222-2222-2222-2222-222222222201"; // Rixey Manor
const V2="22222222-2222-2222-2222-222222222202"; // Crestwood Farm

// Existing wedding IDs from seed
const WEDDINGS = {
  booked109: "44444444-4444-4444-4444-444444000109",
  inquiry110: "44444444-4444-4444-4444-444444000110",
  inquiry111: "44444444-4444-4444-4444-444444000111",
};

function uuid(prefix, n) {
  return prefix + String(n).padStart(4, "0") + "-0000-0000-000000000001";
}
function daysBefore(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString();
}
function daysAfter(n) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString();
}
function dateStr(daysAgo) {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

async function post(table, data) {
  const r = await fetch(new globalThis.URL(table, BASE+"/"), {
    method:"POST",
    headers:{apikey:SRK,Authorization:"Bearer "+SRK,"Content-Type":"application/json",Prefer:"return=minimal,resolution=ignore-duplicates"},
    body:JSON.stringify(data)
  });
  console.log("  "+table+": HTTP "+r.status+(r.ok?"":" — "+(await r.text()).slice(0,120)));
}

async function run() {
  console.log("=== Seeding Agent + Intelligence demo data ===\n");

  // ─── 1. MORE WEDDINGS (for pipeline fullness) ────────────────────────
  console.log("1. Weddings...");
  const newWeddings = [];
  const newPeople = [];
  const couples = [
    ["Emma","Wright","Liam","Chen","the_knot","2026-09-12",85,"hot"],
    ["Sofia","Patel","Noah","Kim","weddingwire","2026-10-03",72,"warm"],
    ["Ava","Johnson","Mason","Rivera","google","2026-11-07",45,"cool"],
    ["Mia","Thompson","Ethan","Nguyen","instagram","2027-03-21",90,"hot"],
    ["Isabella","Davis","Jack","Wilson","referral","2027-04-18",60,"warm"],
    ["Olivia","Garcia","Ben","Taylor","website","2026-08-22",35,"cool"],
    ["Harper","Lee","Owen","Brown","the_knot","2027-06-14",78,"warm"],
    ["Ella","Martinez","Lucas","Anderson","weddingwire","2026-12-05",20,"cold"],
    ["Aria","Robinson","Henry","Thomas","google","2027-01-30",55,"warm"],
    ["Luna","Clark","Aiden","Jackson","referral","2027-05-10",92,"hot"],
    ["Zoe","Hall","Caleb","White","instagram","2027-02-14",40,"cool"],
    ["Lily","Allen","James","Scott","walk_in","2026-07-19",15,"frozen"],
  ];

  const statuses = ["inquiry","inquiry","inquiry","tour_scheduled","tour_scheduled",
    "tour_completed","tour_completed","proposal_sent","proposal_sent","booked","booked","lost"];

  for (let i = 0; i < couples.length; i++) {
    const [p1f,p1l,p2f,p2l,src,wdate,heat,tier] = couples[i];
    const wid = "44444444-4444-4444-4444-444444000" + (200+i);
    newWeddings.push({
      id:wid, venue_id:V, status:statuses[i], source:src,
      wedding_date:wdate, guest_count_estimate:80+Math.floor(Math.random()*120),
      heat_score:heat, temperature_tier:tier,
      inquiry_date:daysBefore(30+i*5), booking_value:7000+Math.floor(Math.random()*8000),
    });
    newPeople.push(
      {wedding_id:wid, venue_id:V, first_name:p1f, last_name:p1l, role:"partner1", email:p1f.toLowerCase()+"."+p1l.toLowerCase()+"@gmail.com"},
      {wedding_id:wid, venue_id:V, first_name:p2f, last_name:p2l, role:"partner2", email:null},
    );
  }
  await post("weddings", newWeddings);
  await post("people", newPeople);

  // ─── 2. INTERACTIONS (bulk inbox) ────────────────────────────────────
  console.log("2. Interactions...");
  const interactions = [];
  const inboundSubjects = [
    ["Availability for September 2026?","Hi! We just got engaged and are looking at venues in the Culpeper area. Is September 12, 2026 available? We are expecting around 130 guests. Thanks so much!"],
    ["Question about catering policy","Hello, I was reading your website and had a question about the BYOB catering policy. Do we need to hire a licensed caterer or can we self-cater? We are foodies and want to do something unique."],
    ["Tour request — October wedding","We would love to schedule a tour! We are thinking October 2026 for about 100 guests. What dates do you have available for a visit?"],
    ["Rain plan?","Hi Sarah! Quick question — what happens if it rains on the wedding day? Do you have an indoor ceremony option?"],
    ["Photo locations on property","Hi! Our photographer asked about the best photo spots at Rixey. Could you share a list or photos of popular ceremony/portrait locations?"],
    ["Table and chair details","What tables and chairs come with the venue rental? Do we need to rent additional seating for the ceremony?"],
    ["Rehearsal dinner question","Can we host the rehearsal dinner on-site the night before? What would that look like cost-wise?"],
    ["Follow up — proposal review","Hi Sarah, just following up on the proposal you sent over last week. Ryan and I have a few questions about the timeline for the deposit."],
    ["Vendor recommendations","Do you have a preferred vendor list? Specifically looking for a florist and DJ who know the venue well."],
    ["Accommodation options","Are there rooms at Rixey Manor for the wedding party to stay? And is there a hotel block option nearby?"],
    ["Weekend availability 2027","Hi! We are looking at spring 2027 — do you have any Saturday availability in April or May?"],
    ["Pricing breakdown","Could you send over a full pricing breakdown including any add-ons like extra hours, ceremony setup, etc.?"],
    ["ADA accessibility","Hi, my grandmother uses a wheelchair. Can you tell me about the accessibility of the ceremony and reception areas?"],
    ["Instagram inquiry","Saw your venue on Instagram and it is GORGEOUS! How do we start the process? My fiance and I are newly engaged."],
    ["Dietary accommodations","We have several guests with severe allergies (peanuts, shellfish). How does your BYOB catering model handle this?"],
    ["Day-of coordinator","Do you provide a day-of coordinator or do we need to hire one separately?"],
    ["Pet policy follow-up","You mentioned dogs are allowed for the ceremony — do you have any specific rules? Our golden retriever is very well-behaved!"],
    ["Thank you!","Sarah, just wanted to say thank you for the amazing tour yesterday. The property is even more beautiful in person. We are going to talk it over this weekend!"],
    ["Deposit question","Quick question — is the deposit refundable if we need to change our date? And can we pay via credit card?"],
    ["Decor restrictions","Are there any restrictions on what we can hang or where we can place candles? Want to make sure our florist knows before she plans."],
  ];

  const outboundReplies = [
    "Thank you for reaching out! Congratulations on your engagement. September 12, 2026 is currently available. I would love to schedule a tour so you can see the property in person.",
    "Great question! At Rixey Manor, all food must be prepared by a licensed caterer with proper insurance. We have a wonderful preferred vendor list with caterers who know our kitchen setup well.",
    "We would love to have you visit! I have openings this Saturday at 11am and next Tuesday at 2pm. Which works better for you?",
    "Great question! We have a beautiful covered pavilion that serves as our rain plan. The ceremony can move there seamlessly and it still has gorgeous views of the mountains.",
    "Of course! Our most popular photo spots are: the garden gazebo, the brick pathway, the grand oak tree, the pond dock, and the sunset overlook. I will send you a PDF with photos of each!",
  ];

  for (let i = 0; i < inboundSubjects.length; i++) {
    const [subj, body] = inboundSubjects[i];
    const wid = i < 12 ? "44444444-4444-4444-4444-444444000" + (200+i) : null;
    const pid = newPeople[i*2] ? null : null; // skip person linking for simplicity
    interactions.push({
      venue_id:V, wedding_id:wid, type:"email", direction:"inbound",
      subject:subj, body_preview:body.slice(0,200), full_body:body,
      timestamp:daysBefore(45 - i*2),
    });
    // Add outbound reply for first 5
    if (i < outboundReplies.length) {
      interactions.push({
        venue_id:V, wedding_id:wid, type:"email", direction:"outbound",
        subject:"Re: "+subj, body_preview:outboundReplies[i].slice(0,200), full_body:outboundReplies[i],
        timestamp:daysBefore(44 - i*2),
      });
    }
  }
  await post("interactions", interactions);

  // ─── 3. DRAFTS (mix of statuses) ────────────────────────────────────
  console.log("3. Drafts...");
  const drafts = [
    {venue_id:V, interaction_id:null, status:"pending", subject:"Re: Weekend availability 2027", draft_body:"Hi there! Congratulations on your engagement! We do have a few Saturdays open in spring 2027. Let me pull up the calendar — April 12, April 26, and May 10 are all currently available. Would you like to schedule a tour to see the property? Our spring weekends tend to book quickly!",created_at:daysBefore(1)},
    {venue_id:V, interaction_id:null, status:"pending", subject:"Re: Pricing breakdown", draft_body:"Thank you for your interest in Rixey Manor! Here is a quick overview of our pricing:\n\n- Venue rental (full day, Fri-Sun): $8,500\n- Ceremony setup: Included\n- Tables, chairs, linens: Included\n- Extra hour: $500/hr\n- Rehearsal dinner add-on: $1,500\n\nI would love to discuss this in more detail during a tour. When works for you?",created_at:daysBefore(1)},
    {venue_id:V, interaction_id:null, status:"pending", subject:"Re: ADA accessibility", draft_body:"Great question, and thank you for thinking ahead for your grandmother! Our ceremony space on the lawn is fully accessible via a paved pathway. The reception barn has a ground-level entrance with no steps. Restrooms are also ADA compliant. We can also arrange preferred seating to make sure she has the best view!",created_at:daysBefore(0)},
    {venue_id:V, interaction_id:null, status:"approved", subject:"Re: Tour request — October wedding", draft_body:"We would love to have you visit! I have openings this Saturday at 11am and next Tuesday at 2pm. During the tour, you will see our ceremony lawn, the reception barn, the bridal suite, and all the photo locations. The tour usually takes about 45 minutes. Which time works best?",created_at:daysBefore(3)},
    {venue_id:V, interaction_id:null, status:"sent", subject:"Re: Rain plan?", draft_body:"Great question! We have a beautiful covered pavilion that serves as our rain plan. It can seat up to 200 guests and still has gorgeous views of the mountains and grounds. We monitor the weather closely the week of each wedding and coordinate with your vendors to make the call together. You are always in good hands!",created_at:daysBefore(5)},
    {venue_id:V, interaction_id:null, status:"sent", subject:"Re: Photo locations on property", draft_body:"Our most popular photo spots are the garden gazebo (perfect golden hour backdrop), the brick pathway with the oak canopy, the pond dock for reflections, the bridal suite balcony, and the sunset overlook behind the barn. I will email you a PDF with sample photos from each location!",created_at:daysBefore(7)},
    {venue_id:V, interaction_id:null, status:"rejected", subject:"Re: Dietary accommodations", draft_body:"I completely understand the concern about allergies...",created_at:daysBefore(4)},
  ];
  await post("drafts", drafts);

  // ─── 4. INTELLIGENCE EXTRACTIONS ─────────────────────────────────────
  console.log("4. Intelligence extractions...");
  const extractions = [
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",interaction_id:null,extracted_data:{budget_range:"$30k-40k",guest_count:130,wedding_season:"fall",pain_points:["parking logistics"],competing_venues:["Early Mountain Vineyards","Pippin Hill"],lead_source:"the_knot",communication_style:"enthusiastic",phone_number:null},created_at:daysBefore(40)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000201",interaction_id:null,extracted_data:{budget_range:"$25k-35k",guest_count:100,wedding_season:"fall",pain_points:["catering flexibility"],competing_venues:["Montfair Resort Farm"],lead_source:"weddingwire",communication_style:"detail-oriented",phone_number:"434-555-9901"},created_at:daysBefore(35)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",interaction_id:null,extracted_data:{budget_range:"$40k-50k",guest_count:180,wedding_season:"spring",pain_points:["rain plan","large guest count"],competing_venues:["The Inn at Willow Grove","Keswick Hall"],lead_source:"instagram",communication_style:"brief but warm",phone_number:"703-555-8812"},created_at:daysBefore(25)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000204",interaction_id:null,extracted_data:{budget_range:"$20k-30k",guest_count:85,wedding_season:"spring",pain_points:["distance from DC"],competing_venues:["Airlie Conference Center"],lead_source:"referral",communication_style:"casual",phone_number:null},created_at:daysBefore(20)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",interaction_id:null,extracted_data:{budget_range:"$50k+",guest_count:200,wedding_season:"spring",pain_points:[],competing_venues:[],lead_source:"referral",communication_style:"decisive",phone_number:"571-555-1234"},created_at:daysBefore(10)},
  ];
  await post("intelligence_extractions", extractions);

  // ─── 5. MORE KNOWLEDGE BASE ENTRIES ──────────────────────────────────
  console.log("5. Knowledge base...");
  const kb = [
    {venue_id:V,question:"What is the alcohol policy?",answer:"Rixey Manor is BYOB. You supply all beverages. We provide the bar setup, glassware, and ice. An ABC license is required for anything beyond beer and wine.",category:"bar",source:"manual"},
    {venue_id:V,question:"What time does the venue close?",answer:"Music must end by 11:00 PM. All vendors and guests must vacate by midnight. We offer extended hours until midnight for an additional $500.",category:"logistics",source:"manual"},
    {venue_id:V,question:"Is there a getting-ready space?",answer:"Yes! The bridal suite is a beautifully renovated farmhouse with a full-length mirror, natural light, and room for up to 10 people. The groom suite is in the barn loft with leather seating.",category:"spaces",source:"manual"},
    {venue_id:V,question:"Can we have a live band?",answer:"Absolutely! We have full power available in the barn and on the lawn. Many couples choose a live band for the reception and acoustic music for the ceremony. Sound levels should be reasonable after 10 PM.",category:"entertainment",source:"manual"},
    {venue_id:V,question:"What happens to leftover food?",answer:"Your caterer handles all food logistics. Any leftovers go home with you or can be donated. We have refrigeration available if needed.",category:"catering",source:"manual"},
    {venue_id:V,question:"Do you allow sparkler exits?",answer:"Yes! Sparkler exits are one of our most popular send-offs. We ask that you use 20-inch sparklers (not the short ones) and designate someone to collect used sparklers in a metal bucket.",category:"send_off",source:"manual"},
    {venue_id:V,question:"Is there parking on site?",answer:"We have parking for up to 100 cars on the property. For larger weddings, we recommend shuttle service from nearby hotels. Overflow parking is available in the lower field.",category:"logistics",source:"manual"},
    {venue_id:V,question:"Can we do a first look on the property?",answer:"Of course! The garden gazebo and the oak pathway are both popular first-look spots. We will make sure the area is clear and private during your scheduled time.",category:"ceremony",source:"manual"},
    {venue_id:V,question:"What is included in the rental?",answer:"The venue rental includes: full-day access (10am-midnight), ceremony and reception spaces, tables and chairs, basic ivory linens, bridal and groom suites, setup/breakdown time, on-site coordinator, and parking.",category:"pricing",source:"manual"},
    {venue_id:V,question:"Do you offer payment plans?",answer:"Yes. We require a 50% deposit to secure your date, with the remaining balance due 14 days before the wedding. We accept checks, credit cards, and bank transfers.",category:"pricing",source:"manual"},
  ];
  await post("knowledge_base", kb);

  // ─── 6. TREND RECOMMENDATIONS ────────────────────────────────────────
  console.log("6. Trend recommendations...");
  const recs = [
    {venue_id:V,recommendation_type:"pricing",title:"Consider early-bird pricing for January-March dates",body:"Search interest for winter weddings in Virginia has increased 23% YoY. An early-bird discount could capture budget-conscious couples looking for off-peak deals.",data_source:"Google Trends",priority:"medium",status:"pending",supporting_data:{trend_change:"+23%",period:"Jan-Mar 2027"}},
    {venue_id:V,recommendation_type:"marketing",title:"Boost Instagram presence — engagement photo content",body:"Instagram referrals have generated 3 inquiries this month (up from 0 last month). Double down with engagement session content and venue walkthroughs.",data_source:"source_attribution",priority:"high",status:"pending",supporting_data:{inquiries_from_ig:3,previous_month:0}},
    {venue_id:V,recommendation_type:"operational",title:"Add Saturday afternoon tour slots",body:"68% of tour requests specify Saturday. Currently only offering 11am. Adding a 2pm slot could reduce scheduling friction and convert faster.",data_source:"tours",priority:"high",status:"applied",applied_at:daysBefore(7),supporting_data:{saturday_pct:68,current_slots:1}},
    {venue_id:V,recommendation_type:"content",title:"Update website photos — add fall foliage shots",body:"Fall wedding searches peak in August. Current website gallery has no autumn imagery. Schedule a styled shoot in October to capture foliage.",data_source:"Google Trends",priority:"medium",status:"applied",applied_at:daysBefore(14),supporting_data:{outcome_notes:"Styled shoot booked for Oct 5 with Hannah Kate Photography"}},
    {venue_id:V,recommendation_type:"competitive",title:"Highlight BYOB advantage in marketing",body:"Competing venues charge $45-85/person for bar packages. Your BYOB model saves couples $6,000-$12,000. This is rarely mentioned in your marketing.",data_source:"market_analysis",priority:"high",status:"pending",supporting_data:{competitor_bar_cost:"$45-85/pp",avg_savings:"$9,000"}},
    {venue_id:V,recommendation_type:"weather",title:"Prepare rain-plan talking points for June tours",body:"NOAA forecast shows above-average rainfall probability for June 2026. Tours during this period should proactively address the covered pavilion option.",data_source:"NOAA",priority:"low",status:"dismissed",dismissed_at:daysBefore(10),supporting_data:{rain_probability:"above_average"}},
  ];
  await post("trend_recommendations", recs);

  // ─── 7. AI BRIEFINGS ─────────────────────────────────────────────────
  console.log("7. AI briefings...");
  const briefings = [
    {venue_id:V,briefing_type:"weekly",content:{summary:"Strong week for Rixey Manor. 4 new inquiries (2 from The Knot, 1 Instagram, 1 referral). One tour completed — Mia & Ethan were very enthusiastic. Pipeline heat is rising with 3 leads in the hot tier. Two drafts pending approval. Recommendation: add Saturday PM tour slot to reduce scheduling friction.",trend_highlights:["Wedding venue searches up 12% WoW in Virginia","Barn wedding interest steady"],weather_outlook:"Clear skies expected through next Saturday — great for tours",recommendations:["Follow up with Emma & Liam (hot lead, no tour scheduled yet)","Approve pending draft for Sofia & Noah"]},created_at:daysBefore(0)},
    {venue_id:V,briefing_type:"weekly",content:{summary:"Moderate activity. 2 new inquiries, 1 tour completed, 1 proposal sent. Chloe & Ryan confirmed their booking — deposit received. Lost deal: Lily & James chose a venue closer to DC. Instagram continues to drive quality leads.",trend_highlights:["Elopement searches declining in favor of traditional weddings","Outdoor venue interest seasonal peak approaching"],weather_outlook:"Chance of rain midweek, clear weekend",recommendations:["Update The Knot listing photos","Send follow-up to Ava & Mason (cooling lead)"]},created_at:daysBefore(7)},
    {venue_id:V,briefing_type:"weekly",content:{summary:"Busy week. 5 new inquiries — highest volume this quarter. Tour no-show from WeddingWire lead (follow up). Two proposals outstanding. Budget discussions with Aria & Henry going well. Knowledge gap identified: several couples asking about pet policies — update KB.",trend_highlights:["Virginia wedding costs trending up 8% YoY","Destination-local hybrid trend growing"],weather_outlook:"Warm and sunny — ideal tour weather",recommendations:["Address pet policy knowledge gap","Schedule tour for Luna & Aiden ASAP — hot lead"]},created_at:daysBefore(14)},
    {venue_id:V,briefing_type:"monthly",content:{summary:"March was Rixey Manor's strongest month in 6 months. 12 new inquiries (up 50% MoM), 4 tours completed, 2 bookings confirmed. Revenue pipeline: $127,000 in active proposals. Instagram driving 25% of new inquiries — ROI on social content is clear. BYOB positioning resonating well with budget-conscious couples. Areas for improvement: response time averaging 4.2 hours (target: under 2 hours).",metrics:{new_inquiries:12,tours_completed:4,bookings:2,proposals_sent:3,lost_deals:1},month_over_month:{inquiries_change:"+50%",tours_change:"+33%",bookings_change:"+100%"},strategic_recommendations:["Invest in Instagram content creation","Reduce response time — consider auto-send for initial replies","Add winter wedding package to capture off-peak demand"]},created_at:daysBefore(2)},
  ];
  await post("ai_briefings", briefings);

  // ─── 8. ANOMALY ALERTS ───────────────────────────────────────────────
  console.log("8. Anomaly alerts...");
  const alerts = [
    {venue_id:V,alert_type:"inquiry_spike",severity:"info",title:"Inquiry volume 2x normal this week",description:"8 new inquiries received vs. 4-week average of 3.5. Possible driver: new Knot listing photos uploaded last Monday.",status:"active",detected_at:daysBefore(2),supporting_data:{current:8,average:3.5,likely_cause:"knot_photo_update"}},
    {venue_id:V,alert_type:"response_time",severity:"warning",title:"Average response time rising",description:"Mean first-response time increased to 6.2 hours (from 3.1 hours last week). 2 inquiries waited over 12 hours. This may be impacting conversion.",status:"active",detected_at:daysBefore(1),supporting_data:{current_avg_hours:6.2,previous_avg_hours:3.1,slow_responses:2}},
    {venue_id:V,alert_type:"lead_cooling",severity:"warning",title:"3 leads cooling rapidly",description:"Ava & Mason, Olivia & Ben, and Ella & Lucas have dropped below 30 heat score with no recent engagement. Consider re-engagement sequence.",status:"active",detected_at:daysBefore(3),supporting_data:{cooling_leads:["Ava & Mason","Olivia & Ben","Ella & Lucas"]}},
    {venue_id:V,alert_type:"competitor_mention",severity:"info",title:"Competitor mentioned in 2 threads",description:"Pippin Hill Farm was mentioned by 2 separate inquiry couples this week. Both cited outdoor ceremony options as the draw. Ensure our outdoor spaces are prominently featured in responses.",status:"resolved",detected_at:daysBefore(10),resolved_at:daysBefore(8),supporting_data:{competitor:"Pippin Hill Farm",mentions:2}},
  ];
  await post("anomaly_alerts", alerts);

  // ─── 9. ENGAGEMENT EVENTS ────────────────────────────────────────────
  console.log("9. Engagement events...");
  const events = [
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",event_type:"email_opened",metadata:{subject:"Welcome to Rixey Manor"},created_at:daysBefore(38)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",event_type:"link_clicked",metadata:{url:"pricing-guide.pdf"},created_at:daysBefore(37)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000200",event_type:"tour_booked",metadata:{date:"2026-03-15"},created_at:daysBefore(35)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000201",event_type:"email_opened",metadata:{subject:"Re: Question about catering"},created_at:daysBefore(33)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",event_type:"email_reply",metadata:{subject:"Thank you!"},created_at:daysBefore(24)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",event_type:"tour_booked",metadata:{date:"2026-03-22"},created_at:daysBefore(22)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000203",event_type:"tour_completed",metadata:{feedback:"Loved it!"},created_at:daysBefore(18)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",event_type:"email_reply",metadata:{subject:"We want to book!"},created_at:daysBefore(8)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",event_type:"proposal_sent",metadata:{amount:13500},created_at:daysBefore(7)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000209",event_type:"deposit_received",metadata:{amount:6750},created_at:daysBefore(5)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000206",event_type:"email_opened",metadata:{subject:"Spring 2027 at Rixey Manor"},created_at:daysBefore(15)},
    {venue_id:V,wedding_id:"44444444-4444-4444-4444-444444000206",event_type:"link_clicked",metadata:{url:"gallery"},created_at:daysBefore(14)},
  ];
  await post("engagement_events", events);

  // ─── 10. SEARCH TRENDS (more time-series data) ───────────────────────
  console.log("10. Search trends...");
  const trendKeywords = ["wedding venues virginia","barn wedding virginia","outdoor wedding venue","wedding venue culpeper","rixey manor wedding"];
  const trends = [];
  for (const kw of trendKeywords) {
    for (let week = 0; week < 12; week++) {
      trends.push({
        venue_id:V, keyword:kw,
        interest_score: 40 + Math.floor(Math.random()*50),
        snapshot_date: dateStr(week*7),
        metro: "US-VA-584",
      });
    }
  }
  await post("search_trends", trends);

  // ─── 11. MORE SOURCE ATTRIBUTION ─────────────────────────────────────
  console.log("11. Source attribution...");
  const sources = [
    {venue_id:V,source:"the_knot",period_start:dateStr(30),period_end:dateStr(0),inquiries:5,tours:2,bookings:1,revenue:8500,spend:150},
    {venue_id:V,source:"weddingwire",period_start:dateStr(30),period_end:dateStr(0),inquiries:3,tours:1,bookings:0,revenue:0,spend:120},
    {venue_id:V,source:"google",period_start:dateStr(30),period_end:dateStr(0),inquiries:2,tours:1,bookings:1,revenue:12000,spend:200},
    {venue_id:V,source:"instagram",period_start:dateStr(30),period_end:dateStr(0),inquiries:3,tours:1,bookings:0,revenue:0,spend:50},
    {venue_id:V,source:"referral",period_start:dateStr(30),period_end:dateStr(0),inquiries:2,tours:2,bookings:1,revenue:9500,spend:0},
    {venue_id:V,source:"website",period_start:dateStr(30),period_end:dateStr(0),inquiries:1,tours:0,bookings:0,revenue:0,spend:0},
  ];
  await post("source_attribution", sources);

  // ─── 12. API COSTS ───────────────────────────────────────────────────
  console.log("12. API costs...");
  const costs = [];
  for (let d = 0; d < 30; d++) {
    costs.push(
      {venue_id:V,model:"claude-sonnet-4-5-20250514",task_type:"draft_generation",tokens_in:800+Math.floor(Math.random()*400),tokens_out:400+Math.floor(Math.random()*200),cost:0.008+Math.random()*0.004,created_at:daysBefore(d)},
    );
    if (d % 3 === 0) {
      costs.push({venue_id:V,model:"claude-sonnet-4-5-20250514",task_type:"extraction",tokens_in:1200,tokens_out:300,cost:0.006,created_at:daysBefore(d)});
    }
    if (d % 7 === 0) {
      costs.push({venue_id:V,model:"claude-sonnet-4-5-20250514",task_type:"weekly_briefing",tokens_in:3000,tokens_out:1500,cost:0.025,created_at:daysBefore(d)});
    }
  }
  await post("api_costs", costs);

  // ─── 13. LEAD SCORE HISTORY ──────────────────────────────────────────
  console.log("13. Lead score history...");
  const scoreHistory = [];
  for (let i = 0; i < 6; i++) {
    const wid = "44444444-4444-4444-4444-444444000" + (200+i);
    for (let w = 0; w < 6; w++) {
      const baseScore = couples[i][6]; // heat_score
      scoreHistory.push({
        venue_id:V, wedding_id:wid,
        score: Math.max(0, Math.min(100, baseScore - 10 + w*3 + Math.floor(Math.random()*10))),
        recorded_at: daysBefore(35 - w*7),
      });
    }
  }
  await post("lead_score_history", scoreHistory);

  // ─── 14. NLQ HISTORY ─────────────────────────────────────────────────
  console.log("14. Natural language queries...");
  const nlqs = [
    {venue_id:V,query:"How many inquiries did we get this month?",response:"You received 12 new inquiries in March 2026, up 50% from February.",created_at:daysBefore(3)},
    {venue_id:V,query:"Which lead source has the best conversion rate?",response:"Referrals have the highest conversion rate at 50% (2 bookings from 4 inquiries). The Knot is second at 20% (1 booking from 5 inquiries).",created_at:daysBefore(5)},
    {venue_id:V,query:"What is our average booking value?",response:"Your average booking value across confirmed weddings is $10,167. The highest is $13,500 (Luna & Aiden) and lowest is $8,500 (Chloe & Ryan venue rental only).",created_at:daysBefore(8)},
    {venue_id:V,query:"Show me leads that are going cold",response:"3 leads have dropped below 30 heat score: Ava & Mason (45 -> 28), Olivia & Ben (35 -> 18), and Ella & Lucas (20 -> 12). Consider re-engagement emails.",created_at:daysBefore(1)},
    {venue_id:V,query:"What do couples ask about most?",response:"Top questions: 1) Pricing/packages (35%), 2) Catering/BYOB policy (22%), 3) Rain plan (15%), 4) Capacity (12%), 5) Accommodation (10%).",created_at:daysBefore(12)},
  ];
  await post("natural_language_queries", nlqs);

  console.log("\n=== Agent + Intel seed complete! ===");
}

run().catch(e => console.error(e));
