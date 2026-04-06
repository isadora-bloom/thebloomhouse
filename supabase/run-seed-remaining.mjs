const V = "22222222-2222-2222-2222-222222222201";
const W = "44444444-4444-4444-4444-444444000109";
const SRK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzeHhnd3ByeHVxZ2NhdXpseGNiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDYzNDQ5MiwiZXhwIjoyMDkwMjEwNDkyfQ.TkgSGTxLe49t6XlCv7_f-2kCTIKWK_iQ-dhTfzNXcro";
const URL = "https://jsxxgwprxuqgcauzlxcb.supabase.co/rest/v1";

async function post(table, data) {
  const res = await fetch(URL + "/" + table, {
    method: "POST",
    headers: {
      apikey: SRK,
      Authorization: "Bearer " + SRK,
      "Content-Type": "application/json",
      Prefer: "return=minimal,resolution=ignore-duplicates"
    },
    body: JSON.stringify(data)
  });
  console.log("  " + table + ": HTTP " + res.status);
  if (!res.ok) { const t = await res.text(); console.log("    " + t.slice(0, 200)); }
}

async function patch(table, filter, data) {
  const res = await fetch(URL + "/" + table + "?" + filter, {
    method: "PATCH",
    headers: {
      apikey: SRK,
      Authorization: "Bearer " + SRK,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(data)
  });
  console.log("  " + table + " PATCH: HTTP " + res.status);
}

async function run() {
  console.log("=== Seeding remaining couple portal tables ===\n");

  // Budget items
  await post("budget_items", [
    {id:"e4000001-0000-0000-0000-000000000001",venue_id:V,wedding_id:W,category:"Venue",item_name:"Venue rental",budgeted:8500,committed:8500,paid:4250,vendor_name:"Hawthorne Manor",notes:"Balance due 2 weeks before",sort_order:1},
    {id:"e4000001-0000-0000-0000-000000000002",venue_id:V,wedding_id:W,category:"Photography",item_name:"Photography package",budgeted:4200,committed:4200,paid:1000,vendor_name:"Hannah Kate Photography",notes:null,sort_order:2},
    {id:"e4000001-0000-0000-0000-000000000003",venue_id:V,wedding_id:W,category:"Videography",item_name:"Videography package",budgeted:3500,committed:3500,paid:800,vendor_name:"Ridge Run Films",notes:null,sort_order:3},
    {id:"e4000001-0000-0000-0000-000000000004",venue_id:V,wedding_id:W,category:"Music",item_name:"DJ services",budgeted:1800,committed:1800,paid:500,vendor_name:"Blue Ridge Beats",notes:null,sort_order:4},
    {id:"e4000001-0000-0000-0000-000000000005",venue_id:V,wedding_id:W,category:"Catering",item_name:"Dinner + cocktail hour",budgeted:8500,committed:8500,paid:2000,vendor_name:"Wildflower Catering",notes:"148 guests plated",sort_order:5},
    {id:"e4000001-0000-0000-0000-000000000006",venue_id:V,wedding_id:W,category:"Flowers",item_name:"Floral package",budgeted:3200,committed:3200,paid:800,vendor_name:"Stems & Soil",notes:null,sort_order:6},
    {id:"e4000001-0000-0000-0000-000000000007",venue_id:V,wedding_id:W,category:"Cake",item_name:"Wedding cake",budgeted:650,committed:650,paid:0,vendor_name:"Sugar & Bloom Bakery",notes:null,sort_order:7},
    {id:"e4000001-0000-0000-0000-000000000008",venue_id:V,wedding_id:W,category:"Beauty",item_name:"Hair & makeup",budgeted:1400,committed:1400,paid:350,vendor_name:"Glow Beauty Studio",notes:null,sort_order:8},
    {id:"e4000001-0000-0000-0000-000000000009",venue_id:V,wedding_id:W,category:"Attire",item_name:"Wedding dress",budgeted:2800,committed:2800,paid:2800,vendor_name:null,notes:"Maggie Sottero",sort_order:9},
    {id:"e4000001-0000-0000-0000-000000000010",venue_id:V,wedding_id:W,category:"Attire",item_name:"Groom suit",budgeted:1200,committed:1200,paid:600,vendor_name:null,notes:"Generation Tux",sort_order:10},
    {id:"e4000001-0000-0000-0000-000000000011",venue_id:V,wedding_id:W,category:"Stationery",item_name:"Invitations",budgeted:600,committed:600,paid:600,vendor_name:null,notes:"Minted.com",sort_order:11},
    {id:"e4000001-0000-0000-0000-000000000012",venue_id:V,wedding_id:W,category:"Rentals",item_name:"Lounge furniture",budgeted:900,committed:900,paid:0,vendor_name:"Paisley & Jade",notes:null,sort_order:12},
    {id:"e4000001-0000-0000-0000-000000000013",venue_id:V,wedding_id:W,category:"Favors",item_name:"Honey jar favors",budgeted:250,committed:250,paid:250,vendor_name:null,notes:"200 jars",sort_order:13},
    {id:"e4000001-0000-0000-0000-000000000014",venue_id:V,wedding_id:W,category:"Other",item_name:"Tips & gratuities",budgeted:1500,committed:0,paid:0,vendor_name:null,notes:"Cash envelopes",sort_order:14},
  ]);

  // Budget payments
  await post("budget_payments", [
    {budget_item_id:"e4000001-0000-0000-0000-000000000001",venue_id:V,wedding_id:W,amount:4250,payment_date:"2025-12-01",payment_method:"check",notes:"Deposit 50%"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000002",venue_id:V,wedding_id:W,amount:1000,payment_date:"2025-11-15",payment_method:"credit_card",notes:"Retainer"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000005",venue_id:V,wedding_id:W,amount:2000,payment_date:"2026-01-10",payment_method:"credit_card",notes:"Deposit"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000008",venue_id:V,wedding_id:W,amount:350,payment_date:"2026-02-01",payment_method:"venmo",notes:"Deposit"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000009",venue_id:V,wedding_id:W,amount:2800,payment_date:"2026-01-20",payment_method:"credit_card",notes:"Paid in full"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000011",venue_id:V,wedding_id:W,amount:600,payment_date:"2026-02-15",payment_method:"credit_card",notes:"Paid in full"},
    {budget_item_id:"e4000001-0000-0000-0000-000000000013",venue_id:V,wedding_id:W,amount:250,payment_date:"2026-03-01",payment_method:"credit_card",notes:"Paid in full"},
  ]);

  // RSVP config
  await post("rsvp_config", {
    venue_id:V,wedding_id:W,rsvp_deadline:"2026-04-30",
    ask_meal_choice:true,ask_dietary:true,ask_song_request:true,
    ask_accessibility:true,ask_message:true,allow_maybe:false,
    custom_questions:[{label:"Rehearsal dinner?",type:"boolean"},{label:"Hotel if staying overnight",type:"text"}]
  });

  // RSVP responses
  await post("rsvp_responses", [
    {venue_id:V,wedding_id:W,guest_id:"c8000001-0000-0000-0000-000000000001",song_request:"Dont Stop Believin",message_to_couple:"So happy for you two!",custom_answers:{rehearsal:true,hotel:"Hampton Inn"}},
    {venue_id:V,wedding_id:W,guest_id:"c8000001-0000-0000-0000-000000000002",allergies:"Gluten-free",message_to_couple:"Cannot wait!",custom_answers:{}},
    {venue_id:V,wedding_id:W,guest_id:"c8000001-0000-0000-0000-000000000004",song_request:"September by Earth Wind and Fire",custom_answers:{rehearsal:true}},
  ]);

  // Venue config feature_flags
  const cfgRes = await fetch(URL+"/venue_config?venue_id=eq."+V+"&select=feature_flags", {
    headers: {apikey:SRK,Authorization:"Bearer "+SRK}
  });
  const cfgData = await cfgRes.json();
  const flags = cfgData[0]?.feature_flags || {};

  flags.checklist_template = {
    tasks: [
      {id:"t1",task_text:"Set your budget",category:"Venue",included:true},
      {id:"t2",task_text:"Complete alignment worksheets",category:"Venue",included:true},
      {id:"t3",task_text:"Book photographer",category:"Vendors",included:true},
      {id:"t4",task_text:"Book videographer",category:"Vendors",included:true},
      {id:"t5",task_text:"Book DJ or band",category:"Vendors",included:true},
      {id:"t6",task_text:"Book hair & makeup",category:"Vendors",included:true},
      {id:"t7",task_text:"Choose caterer and finalize menu",category:"Vendors",included:true,description:"Hawthorne Manor is BYOB"},
      {id:"t8",task_text:"Hire florist",category:"Vendors",included:true},
      {id:"t9",task_text:"Submit proof of insurance for caterer",category:"Venue",included:true,is_custom:true},
      {id:"t10",task_text:"Send save-the-dates",category:"Guests",included:true},
      {id:"t11",task_text:"Send invitations",category:"Guests",included:true},
      {id:"t12",task_text:"Build day-of timeline",category:"Timeline",included:true},
      {id:"t13",task_text:"Finalize seating chart",category:"Guests",included:true},
      {id:"t14",task_text:"Write vows",category:"Other",included:true},
      {id:"t15",task_text:"Schedule final walkthrough at Hawthorne Manor",category:"Venue",included:true,is_custom:true},
    ],
    custom_categories: []
  };
  flags.decor_config = {
    venue_spaces:["Round Guest Tables","Long Farm Tables","Head Table","Sweetheart Table","Cocktail Tables","Ceremony Arch","Card & Gift Table","Cake Table","Dessert Table","Bar Area","Photo Booth","Lounge Area","Porch & Steps"],
    venue_provides:["Ceremony chairs (200)","Reception tables (20 round)","Farm tables (4)","Cocktail tables (6)","Basic linens"],
    restrictions:{no_confetti:true,no_glitter:true,no_open_flame:false,no_nails_walls:true,no_rice:true},
    custom_restrictions:["No hanging from chandeliers","Candles must be in hurricane glass"],
    decor_notes:"We love creative couples! Check with Sarah before hanging anything."
  };
  flags.bar_config = {
    default_bar_type:"beer-wine",
    default_guest_count:150,
    notes:"Hawthorne Manor is BYOB. We provide bar setup, glassware, ice."
  };

  await patch("venue_config","venue_id=eq."+V,{feature_flags:flags});

  console.log("\n=== All done! ===");
}
run().catch(e => console.error(e));
