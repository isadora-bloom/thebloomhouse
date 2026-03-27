/**
 * Bloom Agent: Phrase Library
 * Organized by category and style for personality matching.
 * Used with anti-duplication system to prevent same phrases across venues.
 *
 * Template placeholders:
 *   {ai_name}    - The AI assistant's name (e.g. "Sage")
 *   {owner_name} - The venue owner's name
 *   {venue_name} - The venue name
 */

type PhraseStyle = 'warm' | 'playful' | 'professional' | 'enthusiastic';

type PhraseCategory =
  | 'follow_up_opener'
  | 'soft_cta'
  | 'availability_positive'
  | 'availability_negative'
  | 'tour_invitation'
  | 'thank_you'
  | 'ai_introduction'
  | 'handoff_offer'
  | 'final_follow_up'
  | 'closing_warmth';

type PhraseCategoryEntry = Partial<Record<PhraseStyle, string[]>>;

type PhraseLibrary = Record<PhraseCategory, PhraseCategoryEntry>;

// ============================================================
// SEASONAL LANGUAGE DEFAULTS
// ============================================================

interface SeasonContent {
  imagery: string[];
  phrases: string[];
}

type Season = 'spring' | 'summer' | 'fall' | 'winter';

export const DEFAULT_SEASONAL_CONTENT: Record<Season, SeasonContent> = {
  spring: {
    imagery: [
      'fresh blooms',
      'soft pastels',
      'garden ceremonies',
      'gentle breezes',
      'cherry blossoms',
      'new beginnings',
    ],
    phrases: [
      'Spring here is magical - everything comes alive',
      'The gardens are absolutely stunning this time of year',
      'Perfect weather for an outdoor ceremony',
      "There's something so hopeful about a spring wedding",
    ],
  },
  summer: {
    imagery: [
      'golden sunsets',
      'lush greenery',
      'outdoor celebrations',
      'warm evenings',
      'fireflies',
      'long days',
    ],
    phrases: [
      'Summer evenings here are unforgettable',
      'Long golden hours perfect for photos',
      'The grounds are at their most beautiful',
      'Those summer sunsets are truly something special',
    ],
  },
  fall: {
    imagery: [
      'foliage',
      'rich colors',
      'cozy ambiance',
      'crisp air',
      'harvest',
      'candlelight',
    ],
    phrases: [
      'Fall is absolutely stunning here',
      'The colors that time of year are unreal',
      'Cozy and romantic - fall is one of our favorites',
      'There\'s nothing like autumn light for photos',
    ],
  },
  winter: {
    imagery: [
      'candlelight',
      'intimate warmth',
      'evergreen touches',
      'cozy interiors',
      'snow-dusted views',
      'fireplaces',
    ],
    phrases: [
      'Winter celebrations here feel magical',
      'Candlelight and warmth - so romantic',
      'Intimate and cozy - winter weddings are special',
      'The venue glows in winter',
    ],
  },
};

// ============================================================
// PHRASE LIBRARY
// ============================================================

export const PHRASE_LIBRARY: PhraseLibrary = {
  // ============================================================
  // FOLLOW-UP OPENERS (replacing "circle back", "touch base")
  // ============================================================
  follow_up_opener: {
    warm: [
      'Just wanted to check in...',
      'Hope your planning is going smoothly...',
      'Thinking about your celebration and wanted to reconnect...',
      'Wanted to pop back in...',
      'Hope your week has been good...',
      'Just a quick hello...',
    ],
    playful: [
      'Floating this back to the top of your inbox...',
      'Popping back in real quick...',
      'Just a friendly hello from us...',
      'Your inquiry has been on my mind...',
      "Couldn't help but follow up...",
    ],
    professional: [
      'Following up on our previous conversation...',
      'Wanted to reconnect regarding your inquiry...',
      'Checking in on your venue search...',
      'Reaching back out about your upcoming celebration...',
    ],
    enthusiastic: [
      'Still so excited about your vision!',
      "Can't stop thinking about your wedding plans!",
      'Just had to reach back out...',
      'Your inquiry got us so excited...',
    ],
  },

  // ============================================================
  // SOFT CTA (replacing "at your earliest convenience")
  // ============================================================
  soft_cta: {
    warm: [
      "Whenever you're ready, we're here.",
      "No rush at all - just here when you need us.",
      "Take your time, and let us know when it feels right.",
      "We're here whenever works for you.",
    ],
    playful: [
      "The door's always open!",
      "We'll be here, ready when you are.",
      'Just say the word!',
      "Whenever you're feeling it, we're ready.",
    ],
    professional: [
      'Please feel free to reach out at your convenience.',
      "We're available whenever works best for you.",
      "I'm happy to connect when your schedule allows.",
    ],
    enthusiastic: [
      "We'd absolutely love to show you around!",
      "Can't wait to meet you in person!",
      'So excited to hopefully connect soon!',
    ],
  },

  // ============================================================
  // AVAILABILITY - POSITIVE (date is open)
  // ============================================================
  availability_positive: {
    warm: [
      'Great news - that date is open!',
      "You're in luck! That weekend is available.",
      'Happy to share that date is still open for you.',
      'Good news on your end - that date works!',
    ],
    playful: [
      "Good news alert: that date is totally free!",
      "The stars are aligning - that date's available!",
      "You picked a winner - it's open!",
    ],
    professional: [
      "I'm pleased to confirm that date is currently available.",
      'That date is open on our calendar.',
      "I've verified availability for that date.",
    ],
    enthusiastic: [
      'Amazing news - that date is YOURS if you want it!',
      'Yes!! That date is completely available!',
      "So excited to tell you - it's open!",
    ],
  },

  // ============================================================
  // AVAILABILITY - NEGATIVE (date is booked)
  // ============================================================
  availability_negative: {
    warm: [
      'That date is already spoken for, but let me share some beautiful alternatives...',
      'We have another lovely couple on that date, but here are some options...',
      'That weekend is booked, though we have some wonderful dates nearby...',
    ],
    playful: [
      "That one's taken (someone beat you to it!), but check these out...",
      "Another couple snagged that date, but we've got options...",
    ],
    professional: [
      "That date is currently booked. I'd be happy to suggest alternatives.",
      'We have an existing reservation for that date. May I recommend...',
    ],
    enthusiastic: [
      "That date's booked, but honestly, these alternatives might be even better...",
      'Someone else got that one, but wait until you see these options...',
    ],
  },

  // ============================================================
  // TOUR INVITATION
  // ============================================================
  tour_invitation: {
    warm: [
      "We'd love to show you around in person.",
      'Nothing beats seeing the space for yourself.',
      "Would you like to come see it? We'd be happy to give you a tour.",
    ],
    playful: [
      'Want to come see the magic in person?',
      'Photos are nice, but the real thing is so much better!',
      "Come check it out - we promise it's even prettier in person.",
    ],
    professional: [
      "I'd be pleased to arrange a private tour at your convenience.",
      'We would be honored to show you the property.',
      'May I schedule a tour for you?',
    ],
    enthusiastic: [
      "You HAVE to see it in person - it's incredible!",
      "Seriously, come visit! You're going to love it.",
      "I can't wait to show you around!",
    ],
  },

  // ============================================================
  // THANK YOU FOR INQUIRY
  // ============================================================
  thank_you: {
    warm: [
      'Thanks so much for reaching out!',
      'So glad you found us!',
      'Thank you for thinking of us for your celebration.',
    ],
    playful: [
      'Hey, thanks for reaching out!',
      'So excited you found us!',
      'What a nice surprise in our inbox!',
    ],
    professional: [
      'Thank you for your inquiry.',
      'We appreciate you considering us for your special day.',
      'Thank you for reaching out to us.',
    ],
    enthusiastic: [
      'We are SO excited you reached out!',
      'Wow, thank you for finding us!',
      'This is so exciting - thank you for your inquiry!',
    ],
  },

  // ============================================================
  // AI INTRODUCTION (first email only)
  // ============================================================
  ai_introduction: {
    warm: [
      "I'm {ai_name}, {venue_name}'s digital concierge - I help {owner_name} make sure every inquiry gets the attention it deserves.",
      "Hi! I'm {ai_name}, the AI assistant for {venue_name}. I work alongside {owner_name} to help couples like you.",
      "I'm {ai_name} - {owner_name}'s AI helper here at {venue_name}. I'm here to get you answers quickly!",
    ],
    playful: [
      "I'm {ai_name}, {venue_name}'s friendly AI assistant! I help {owner_name} keep up with all the lovely couples reaching out.",
      "Hey! I'm {ai_name} - the AI sidekick to {owner_name} at {venue_name}.",
    ],
    professional: [
      "I'm {ai_name}, the digital concierge for {venue_name}. I assist {owner_name} in ensuring timely responses to all inquiries.",
      "Allow me to introduce myself - I'm {ai_name}, {venue_name}'s AI assistant, working alongside {owner_name}.",
    ],
    enthusiastic: [
      "I'm {ai_name}! I'm {venue_name}'s AI assistant, and I help {owner_name} make sure no one waits too long for answers!",
      "Hi there! I'm {ai_name}, the AI helper at {venue_name} - {owner_name} and I make a great team!",
    ],
  },

  // ============================================================
  // HANDOFF TO OWNER
  // ============================================================
  handoff_offer: {
    warm: [
      "If you'd prefer to chat with {owner_name} directly, just say the word - they love connecting with couples.",
      'And if you ever want to talk to {owner_name} personally, I can make that happen!',
      "{owner_name} is always happy to jump in if you'd like a human touch.",
    ],
    playful: [
      'Want to talk to the boss? {owner_name} is always happy to chat!',
      "If you'd rather hear from the human in charge, {owner_name}'s door is always open.",
    ],
    professional: [
      'Should you prefer to speak with {owner_name} directly, please let me know and I will arrange that.',
      '{owner_name} is available for direct communication at your request.',
    ],
    enthusiastic: [
      '{owner_name} would LOVE to chat with you personally - just let me know!',
      'Want to meet the amazing human behind this place? {owner_name} is always excited to connect!',
    ],
  },

  // ============================================================
  // FINAL FOLLOW-UP (last outreach)
  // ============================================================
  final_follow_up: {
    warm: [
      "This will be my last note unless something new comes up - but we'd love to host you if the timing works out.",
      "I'll leave you be after this, but know we're here if anything changes.",
      "Just one last hello - we'll be here if you ever want to revisit.",
    ],
    playful: [
      "Last one from me, promise! But if you change your mind, you know where to find us.",
      "I'll stop bugging you after this - but we'd still love to see you!",
    ],
    professional: [
      'This will be my final follow-up. Please know we remain available should your plans change.',
      "I won't continue to follow up, but our door remains open.",
    ],
    enthusiastic: [
      'This is my last note, but I really hope we get to meet you someday!',
      "Final check-in from me - but seriously, we'd love to host your celebration!",
    ],
  },

  // ============================================================
  // CLOSING WARMTH (before sign-off)
  // ============================================================
  closing_warmth: {
    warm: [
      "If you have any questions, I'm here - or {owner_name} is always happy to jump in personally.",
      'Let me know if anything else comes up. We\'re here to help!',
      "Looking forward to hearing from you when the time is right.",
    ],
    playful: [
      'Holler if you need anything!',
      "Questions? Thoughts? Random wedding musings? I'm here for it all.",
    ],
    professional: [
      "Please don't hesitate to reach out with any questions.",
      'I remain at your disposal for any additional information you may need.',
    ],
    enthusiastic: [
      "Can't wait to hear from you!",
      'So excited about the possibility of hosting you!',
    ],
  },
};
