/**
 * Voice Training Games: Static Content Libraries
 *
 * Three games train the venue AI's voice:
 * 1. "Would You Send This?" — review AI-generated drafts
 * 2. "Cringe or Fine?" — judge common phrases
 * 3. "Quick Voice Quiz" — choose between two approaches
 *
 * TODO: Replace static drafts with live AI generation via POST /api/voice-training/generate-draft
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SampleInquiry {
  subject: string
  body: string
  source: 'the_knot' | 'weddingwire' | 'google' | 'instagram' | 'website' | 'referral'
  draft: string
}

export interface CringePhrase {
  phrase: string
  context: string
  verdict: 'cringe' | 'fine'
}

export interface QuizOption {
  text: string
  dimension: 'warmth' | 'formality' | 'enthusiasm' | 'playfulness' | 'brevity'
  score: number // +1 or -1
}

export interface QuizQuestion {
  question: string
  optionA: QuizOption
  optionB: QuizOption
}

// ---------------------------------------------------------------------------
// Would You Send This? — 20 sample inquiries with pre-generated AI drafts
// ---------------------------------------------------------------------------

export const SAMPLE_INQUIRIES: SampleInquiry[] = [
  {
    subject: 'Interested in your venue',
    body: 'Hi! My fiance and I just got engaged and we love your venue. We are thinking spring 2027, about 150 guests. Can you send pricing info?',
    source: 'the_knot',
    draft: `Hi there! Congratulations on your engagement — how exciting!\n\nSpring 2027 sounds absolutely beautiful, and 150 guests is a wonderful size for our space. I'd love to share our pricing details with you!\n\nOur venue rental starts at $8,500 for a Saturday, which includes the full property, setup and breakdown time, and our on-site bridal suite. We're BYOB-friendly, so you have the freedom to choose your own caterer and bar service.\n\nWould you like to schedule a tour? Seeing the grounds in spring light is really something special.\n\nWarmly,\nSage`,
  },
  {
    subject: 'Pricing question',
    body: 'Hello, how much is the venue rental for a Saturday in October? We have about 120 guests.',
    source: 'weddingwire',
    draft: `Hello! Thanks so much for reaching out.\n\nOctober is one of our most popular months — the foliage is absolutely stunning. For a Saturday in October with 120 guests, our venue rental is $9,500. This includes exclusive use of the property from 10am through midnight, the ceremony garden, reception hall, bridal suite, and our dedicated setup team.\n\nI'd recommend booking a tour soon, as October dates tend to go quickly! We have a few Saturdays still open for 2027.\n\nLet me know if you'd like to come see the space!\n\nBest,\nSage`,
  },
  {
    subject: 'Availability check',
    body: 'Do you have June 14, 2027 available? We are looking for outdoor ceremony and indoor reception.',
    source: 'google',
    draft: `Hi! Great news — June 14, 2027 is currently available!\n\nAnd you're in luck — our property is perfectly set up for exactly what you're describing. Our outdoor ceremony garden seats up to 250 with mountain views, and the indoor reception hall has floor-to-ceiling windows so you still get that outdoor feeling.\n\nI'd love to show you both spaces in person. Would a weekend tour work for you?\n\nLooking forward to connecting!\n\nWarmly,\nSage`,
  },
  {
    subject: 'Can we bring our dog?',
    body: 'Hi there! Random question but can we have our dog at the ceremony? He is a golden retriever and very well behaved!',
    source: 'instagram',
    draft: `Oh my goodness, we love a good wedding pup! Golden retrievers are the BEST ring bearers.\n\nAbsolutely — dogs are welcome at ceremonies on our property. We just ask that someone is designated as the "puppy handler" so your furry friend has a plan after the ceremony (our grounds are not fully fenced).\n\nWe've had some of the most adorable ceremony photos featuring four-legged family members. Would you like to see some examples?\n\nCan't wait to meet your pup!\n\nSage`,
  },
  {
    subject: 'BYOB question',
    body: 'We saw that you are BYOB - does that mean we pick our own caterer too? What are the kitchen facilities like?',
    source: 'website',
    draft: `Great question! Yes, we're fully BYOB for both food and beverage — one of the things our couples love most. You have complete freedom to choose any licensed caterer you'd like.\n\nOur prep kitchen includes a commercial refrigerator, warming ovens, ample counter space, and a hand-washing station. It's designed for caterers to stage and serve from, though it's not a full cooking kitchen. Most caterers we work with absolutely love the setup.\n\nWe also have a preferred vendor list if you'd like some tried-and-true recommendations!\n\nWould you like me to send that over?\n\nBest,\nSage`,
  },
  {
    subject: 'Last minute date',
    body: 'I know this is crazy but do you have anything available in the next 3 months? We decided to do a small intimate wedding, maybe 50 guests.',
    source: 'referral',
    draft: `Not crazy at all — some of the most beautiful weddings we've hosted have come together in just a few months!\n\nLet me check our calendar for you. For a smaller celebration of 50 guests, we actually have a couple of options that could work perfectly. Our weekday and Sunday rates are more favorable too, which is a nice bonus for intimate weddings.\n\nCould I give you a call to talk through the available dates? I think we can make something really special happen on a timeline that works for you.\n\nExcited to help!\n\nWarmly,\nSage`,
  },
  {
    subject: 'Tour request',
    body: 'We would love to see the property! When are tours available? We are free most weekends.',
    source: 'the_knot',
    draft: `We'd love to show you around! Tours are available Saturdays and Sundays by appointment — we like to give each couple our full attention so you can really take your time exploring.\n\nWe typically have slots at 10am, 12pm, and 2pm. The whole visit takes about 45 minutes to an hour, and you're welcome to bring family or friends along.\n\nWhat weekend works best for you? I'll get you on the calendar right away!\n\nLooking forward to meeting you,\nSage`,
  },
  {
    subject: 'Comparing venues',
    body: 'We are looking at a few venues in the area. What makes yours stand out? Can you send a breakdown of what is included?',
    source: 'google',
    draft: `I appreciate you asking — it's such an important decision!\n\nHere's what couples consistently tell us sets us apart:\n\n- Full BYOB freedom (food and bar) so you're never locked into an overpriced package\n- Exclusive property access — no double bookings, no shared spaces\n- Stunning outdoor ceremony site with mountain views AND a beautiful indoor backup\n- Getting-ready suites for both wedding parties\n- A dedicated coordinator to help with timeline and logistics\n\nOur all-inclusive rental covers the full property from morning to midnight, tables, chairs, linens, and our setup/breakdown team.\n\nHonestly, I think the best way to feel the difference is to visit. Would you like to schedule a tour?\n\nBest,\nSage`,
  },
  {
    subject: 'Large wedding question',
    body: 'We are planning a big celebration - 250+ guests. Can your venue handle that? What are the options for a large group?',
    source: 'weddingwire',
    draft: `What a celebration that's going to be! We love big, joyful weddings.\n\nOur property can accommodate up to 300 guests with a combined indoor/outdoor layout. For groups over 200, most couples use both the reception hall and our covered pavilion, which creates a wonderful flow between spaces.\n\nFor the ceremony, our main garden site seats 300 comfortably with room to spare.\n\nA few things to note for larger groups: we recommend tent rental for the cocktail hour area, and we have a preferred list of caterers experienced with 250+ person events.\n\nI'd love to walk you through the layout in person — would you be available for a tour soon?\n\nWarmly,\nSage`,
  },
  {
    subject: 'Budget concerns',
    body: 'We love your venue but we are on a tight budget. Is there any flexibility on pricing or any off-season discounts?',
    source: 'the_knot',
    draft: `I completely understand — planning a wedding is a big investment, and we want to make it work for you if we can.\n\nHere are a few options that might help:\n\n- Friday and Sunday rentals are 30% less than Saturday rates\n- January through March pricing is reduced across the board\n- We offer a 10% discount for military families and first responders\n- Because we're BYOB, you'll save significantly on food and bar compared to venues with required in-house catering\n\nMany of our couples have found that the BYOB flexibility alone saves them $5,000-$10,000 compared to other venues in the area.\n\nWould you like to chat about what options might work for your budget? I'm happy to get creative!\n\nWarmly,\nSage`,
  },
  {
    subject: 'Weekend availability',
    body: 'Hi! Looking for a Saturday in September or October 2027. What dates do you still have open?',
    source: 'website',
    draft: `Hi! Fall is absolutely gorgeous here — great taste.\n\nFor Saturday availability in 2027, here's what we have:\n\nSeptember: 6th, 13th, and 27th\nOctober: 4th and 25th\n\nOctober is filling up fast (it always does — those fall colors!), so if any of those dates catch your eye, I'd recommend securing it soon with a deposit.\n\nWould any of those work for you? And would you like to come see the property first?\n\nLooking forward to hearing from you!\n\nBest,\nSage`,
  },
  {
    subject: 'Accommodation question',
    body: 'Do you have any rooms on site? We have family coming from out of town and want to keep everyone close.',
    source: 'referral',
    draft: `Great question! We have a charming farmhouse on the property with 4 bedrooms that can accommodate up to 10 guests overnight. Most couples reserve it for the wedding party — it's perfect for getting ready the morning of and celebrating the night away.\n\nFor additional guests, we've partnered with two wonderful hotels within 15 minutes of the venue that offer group rates for our wedding families. I'm happy to send you their contact information!\n\nWe also have a list of nearby Airbnbs and vacation rentals that work well for family groups.\n\nWould you like me to put together an accommodation guide for your guests?\n\nWarmly,\nSage`,
  },
  {
    subject: 'Rain plan?',
    body: 'What happens if it rains on the wedding day? Is there an indoor backup option?',
    source: 'the_knot',
    draft: `This is one of the most important questions to ask, and we've got you completely covered!\n\nOur indoor reception hall is a beautiful backup for the ceremony — it has floor-to-ceiling windows, exposed beam ceilings, and seats up to 250. Honestly, some of our rain-day weddings have been the coziest, most romantic celebrations we've hosted.\n\nWe make the call with you the morning of, and our team handles the full transition so you don't have to worry about a thing.\n\nWe also have a covered pavilion that works wonderfully for cocktail hours regardless of weather.\n\nWould you like to see both spaces during a tour?\n\nBest,\nSage`,
  },
  {
    subject: 'Vendor restrictions',
    body: 'Are we required to use specific vendors or can we bring our own? We already have a photographer booked.',
    source: 'weddingwire',
    draft: `You have full freedom here! We have no required vendors — bring your own photographer, DJ, florist, caterer, and bar service. Your photographer is absolutely welcome.\n\nWe do maintain a preferred vendor list of professionals we've worked with and trust, which can be helpful if you're still looking for certain vendors. But it's purely a recommendation, never a requirement.\n\nThe only thing we ask is that caterers and bartenders carry proper insurance, which is standard.\n\nWould you like a copy of our preferred vendor list for any services you're still looking to fill?\n\nBest,\nSage`,
  },
  {
    subject: 'Ceremony only',
    body: 'Would it be possible to just do the ceremony at your venue and have the reception elsewhere?',
    source: 'google',
    draft: `Absolutely! We offer a ceremony-only package that includes use of our outdoor ceremony garden (or indoor space as backup), 2 hours of property access, our bridal suite for getting ready, and setup of ceremony seating.\n\nThe ceremony-only rate is significantly lower than our full-day rental, and it's a wonderful option for couples who want to split their day between locations.\n\nOur ceremony site with the mountain backdrop is truly special — I think you'd love it.\n\nWould you like to schedule a tour to see the ceremony space?\n\nWarmly,\nSage`,
  },
  {
    subject: 'Sunday wedding',
    body: 'Are Sunday weddings significantly cheaper? We are flexible on the day of the week.',
    source: 'instagram',
    draft: `Great question — and yes! Sunday weddings are 30% less than Saturday rates, which is a meaningful savings.\n\nHere's the honest truth: Sunday weddings are some of our favorites. The energy is a little more relaxed, the timeline feels less rushed, and your vendors often have more availability and flexibility too.\n\nWe also offer Friday rates at the same 30% reduction, and weekday events (Monday-Thursday) are 50% off.\n\nThe biggest perk of being flexible on the day? You'll likely have way more date options to choose from.\n\nWant to chat about what dates are available?\n\nBest,\nSage`,
  },
  {
    subject: 'RE: Tour follow up',
    body: 'We toured last weekend and absolutely loved it! What are the next steps to book?',
    source: 'the_knot',
    draft: `That makes us so happy to hear! We loved meeting you too.\n\nHere are the next steps to secure your date:\n\n1. Choose your date — let me know your top pick and I'll confirm availability\n2. Sign the venue agreement — I'll send it digitally for your review\n3. Submit the deposit — $2,500 holds your date (applied to your total)\n\nOnce those three steps are complete, your date is officially yours! The remaining balance is due 30 days before the wedding.\n\nWhich date are you leaning toward? I'll make sure it's still open for you!\n\nSo excited,\nSage`,
  },
  {
    subject: 'Elopement package?',
    body: 'Do you offer any micro-wedding or elopement packages? Just us and maybe 20 guests.',
    source: 'website',
    draft: `We absolutely do, and micro-weddings are one of our favorite things!\n\nOur intimate celebration package (up to 30 guests) includes:\n- 4 hours of property access\n- Ceremony garden or indoor space\n- Bridal suite\n- Setup of ceremony seating and a small reception area\n- A dedicated coordinator for the day\n\nThe intimate package is priced at $3,500, which gives you the full venue experience on a smaller scale.\n\nSome of our most magical celebrations have been intimate ones — there's something so special about a small group in a beautiful space.\n\nWould you like to come see the property?\n\nWarmly,\nSage`,
  },
  {
    subject: 'Noise restrictions?',
    body: 'What time does music need to end? We want a big dance party!',
    source: 'weddingwire',
    draft: `We love a good dance party!\n\nHere are the details: amplified music can go until 11pm, and the venue is yours until midnight for wrap-up and farewells. We're in a rural setting, so the sound carries well without complaints — your DJ can bring the energy.\n\nA few couples have also done a "silent disco" after 11pm to keep the party going, which is always a huge hit.\n\nDuring the reception, there are no decibel restrictions — bring the bass! We just ask that outdoor speakers point away from the neighboring property.\n\nDoes that work for your party plans?\n\nBest,\nSage`,
  },
  {
    subject: 'Photos we saw',
    body: 'The sunset photos on your Instagram are incredible. Where exactly is that ceremony spot?',
    source: 'instagram',
    draft: `Thank you so much! Those sunset shots are our pride and joy.\n\nThat ceremony spot is our hilltop garden — it's the highest point on the property, facing west over the valley. During golden hour (typically 6-7:30pm in summer), the light is just unreal. Your photographer will absolutely love it.\n\nWe also have a second ceremony option in the lower garden, which is surrounded by old-growth trees and has a more intimate, shaded feel.\n\nPhotos really don't do the hilltop justice though — it's one of those places you have to see in person. Would you like to come visit? I'd especially recommend a late afternoon tour so you can catch that light!\n\nWarmly,\nSage`,
  },
]

// ---------------------------------------------------------------------------
// Cringe or Fine? — 25 phrases to judge
// ---------------------------------------------------------------------------

export const CRINGE_PHRASES: CringePhrase[] = [
  { phrase: "Let's circle back on this", context: "In a follow-up email to a couple who hasn't responded", verdict: 'cringe' },
  { phrase: 'Per my last email', context: 'When re-sending information a couple asked for', verdict: 'cringe' },
  { phrase: "I'd love to hear more about your vision!", context: 'In a first response to an inquiry', verdict: 'fine' },
  { phrase: 'Just checking in!', context: 'In a follow-up email after a tour', verdict: 'fine' },
  { phrase: 'Synergy between your vision and our space', context: 'Describing the venue fit', verdict: 'cringe' },
  { phrase: 'We would be honored to be part of your special day', context: 'Closing an inquiry response', verdict: 'fine' },
  { phrase: 'As per our conversation', context: 'Following up after a phone call', verdict: 'cringe' },
  { phrase: "Don't hesitate to reach out!", context: 'Closing any email', verdict: 'fine' },
  { phrase: 'Let me loop in my manager', context: 'When a pricing question comes up', verdict: 'cringe' },
  { phrase: 'How exciting — congratulations!', context: 'Opening a response to a newly engaged couple', verdict: 'fine' },
  { phrase: 'We need to touch base about your event', context: 'Scheduling a call with a booked couple', verdict: 'cringe' },
  { phrase: 'I can already picture your celebration here', context: 'After learning about their wedding vision', verdict: 'fine' },
  { phrase: 'Please advise at your earliest convenience', context: 'Asking a couple to confirm their date', verdict: 'cringe' },
  { phrase: 'Take your time — no rush at all!', context: 'When a couple is deciding between venues', verdict: 'fine' },
  { phrase: 'We offer a holistic wedding experience', context: 'Describing venue services', verdict: 'cringe' },
  { phrase: 'Our venue speaks for itself', context: 'When asked what makes you different', verdict: 'cringe' },
  { phrase: "You're going to have the BEST time", context: 'After a couple books', verdict: 'fine' },
  { phrase: 'Kindly revert back with your decision', context: 'Waiting on a booking decision', verdict: 'cringe' },
  { phrase: "We'd love to show you around!", context: 'Inviting someone to tour', verdict: 'fine' },
  { phrase: 'FYI for your reference', context: 'Sending venue information', verdict: 'cringe' },
  { phrase: 'This is going to be absolutely magical', context: "Responding to a couple's vision description", verdict: 'fine' },
  { phrase: 'Moving forward, we suggest...', context: 'Recommending next steps', verdict: 'cringe' },
  { phrase: "We're here whenever you're ready", context: 'Gentle follow-up', verdict: 'fine' },
  { phrase: 'Let me ping the team', context: 'When asked about availability', verdict: 'cringe' },
  { phrase: 'That sounds wonderful!', context: 'Reacting to wedding plans', verdict: 'fine' },
]

// ---------------------------------------------------------------------------
// Quick Voice Quiz — 10 A/B questions mapping to personality dimensions
// ---------------------------------------------------------------------------

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    question: 'A couple emails asking for pricing. You respond:',
    optionA: { text: 'Share the full pricing breakdown right away', dimension: 'formality', score: 1 },
    optionB: { text: 'Invite them to tour first and discuss pricing in person', dimension: 'formality', score: -1 },
  },
  {
    question: 'How do you start an email to a newly engaged couple?',
    optionA: { text: '"OMG congratulations!!"', dimension: 'enthusiasm', score: 1 },
    optionB: { text: '"Congratulations on your engagement."', dimension: 'enthusiasm', score: -1 },
  },
  {
    question: "A couple hasn't responded in 5 days. You:",
    optionA: { text: 'Send a warm, casual check-in', dimension: 'warmth', score: 1 },
    optionB: { text: "Wait — they'll reach out when ready", dimension: 'warmth', score: -1 },
  },
  {
    question: 'In your emails, contractions like "we\'re" and "you\'ll" are:',
    optionA: { text: 'Natural and friendly — always use them', dimension: 'formality', score: -1 },
    optionB: { text: 'Too casual — spell it out', dimension: 'formality', score: 1 },
  },
  {
    question: 'How many exclamation points per email?',
    optionA: { text: 'One or two — they add warmth', dimension: 'playfulness', score: 1 },
    optionB: { text: 'Zero — keep it clean', dimension: 'playfulness', score: -1 },
  },
  {
    question: "A couple asks a question you're not 100% sure about. You:",
    optionA: { text: '"Great question! Let me double-check and get right back to you"', dimension: 'warmth', score: 1 },
    optionB: { text: '"I\'ll confirm that and follow up shortly."', dimension: 'warmth', score: -1 },
  },
  {
    question: 'Your email closing style:',
    optionA: { text: '"Can\'t wait to meet you!"', dimension: 'enthusiasm', score: 1 },
    optionB: { text: '"Looking forward to connecting."', dimension: 'enthusiasm', score: -1 },
  },
  {
    question: 'When describing the venue, you prefer:',
    optionA: { text: 'Painting a vivid picture with sensory details', dimension: 'playfulness', score: 1 },
    optionB: { text: 'Stating the facts — capacity, amenities, pricing', dimension: 'playfulness', score: -1 },
  },
  {
    question: 'A couple mentions budget concerns. Your approach:',
    optionA: { text: 'Empathize first, then explore flexible options together', dimension: 'warmth', score: 1 },
    optionB: { text: 'Present the numbers clearly and let them decide', dimension: 'warmth', score: -1 },
  },
  {
    question: 'Ideal email length for a first response:',
    optionA: { text: '3-4 short paragraphs — warm and personal', dimension: 'brevity', score: -1 },
    optionB: { text: '2-3 sentences — concise and respectful of their time', dimension: 'brevity', score: 1 },
  },
]
