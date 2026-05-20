/**
 * Nickname dictionary for the identity cascade.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §C.5 (cascade stage 3 — nickname
 * + exact last name match). The dictionary is the doctrine source of
 * truth for "are these two first names the same person under a different
 * familiar form".
 *
 * Doctrine notes:
 *  - Bidirectional. `Tim` is a nickname for `Timothy`; `Timothy` is the
 *    canonical for `Tim`. `nicknamesFor('tim')` and `nicknamesFor(
 *    'timothy')` both return the full set.
 *  - Lowercased. Always normalise the input via lowerTrim before lookup.
 *  - First-name only. Last-name spellings ('Bloggs' vs 'Blogs') do NOT
 *    go through this map — that is a Levenshtein-typo problem and the
 *    cascade gates name matches on EXACT last name.
 *  - Curated, not exhaustive. Operator-specific or culture-specific
 *    pairs missing from v1 should be added in a follow-up via a per-
 *    venue `venue_nicknames` override; do not bloat the global list.
 *
 * v1 coverage (~200 pairs):
 *   - Anglo: ~80 names with the most-common short forms
 *   - Spanish: ~50 names + diminutives ending in -ito/-ita
 *   - South-Asian: ~70 common short forms across Hindi / Punjabi / Tamil
 *     traditions
 *
 * Multi-venue safe. No Rixey-specific clauses.
 */

// Each line is a canonical name followed by its accepted short forms.
// The expander below makes the relation bidirectional and adds every
// short form's reverse mapping. Comments group by tradition.
const NICKNAME_GROUPS: Array<[string, ...string[]]> = [
  // ---- Anglo (~80) -------------------------------------------------------
  ['alexander', 'alex', 'al', 'sandy', 'xander', 'lex'],
  ['alexandra', 'alex', 'alexa', 'sandy', 'lexi', 'ali'],
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony', 'ant'],
  ['barbara', 'barb', 'babs', 'barbie'],
  ['benjamin', 'ben', 'benji', 'benny'],
  ['catherine', 'cathy', 'cath', 'kate', 'katie', 'cat', 'kitty'],
  ['kathleen', 'kathy', 'kate', 'katie'],
  ['katherine', 'kathy', 'kate', 'katie', 'kat', 'kitty'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['christopher', 'chris', 'kit', 'topher'],
  ['christine', 'chris', 'christy', 'tina'],
  ['christina', 'chris', 'christy', 'tina'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davy'],
  ['deborah', 'deb', 'debbie', 'debby'],
  ['donald', 'don', 'donnie'],
  ['douglas', 'doug', 'dougie'],
  ['edward', 'ed', 'eddie', 'ned', 'teddy', 'ted'],
  ['elizabeth', 'liz', 'lizzy', 'lizzie', 'beth', 'betty', 'bess', 'eliza', 'libby'],
  ['emily', 'em', 'emmy', 'millie'],
  ['emma', 'em', 'emmie'],
  ['eugene', 'gene'],
  ['francis', 'frank', 'frankie', 'fran'],
  ['frances', 'fran', 'frannie', 'frankie'],
  ['frederick', 'fred', 'freddy', 'rick'],
  ['gabriel', 'gabe', 'gabby'],
  ['george', 'georgie', 'geo'],
  ['harold', 'harry', 'hal'],
  ['henry', 'hank', 'harry'],
  ['isabel', 'izzy', 'bella', 'belle'],
  ['isabella', 'izzy', 'bella', 'belle'],
  ['jacob', 'jake', 'jakey'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['jennifer', 'jen', 'jenny', 'jenn'],
  ['jeremy', 'jem', 'jerry'],
  ['jessica', 'jess', 'jessie'],
  ['joanna', 'jo', 'jojo'],
  ['johnathan', 'john', 'johnny', 'jack'],
  ['jonathan', 'jon', 'jonny', 'jack'],
  ['john', 'johnny', 'jack', 'jock'],
  ['joseph', 'joe', 'joey'],
  ['joshua', 'josh'],
  ['judith', 'judy'],
  ['julian', 'jules'],
  ['julia', 'jules', 'julie'],
  ['kenneth', 'ken', 'kenny'],
  ['kimberly', 'kim', 'kimmie'],
  ['lawrence', 'larry', 'lars'],
  ['leonard', 'leo', 'lenny'],
  ['leonardo', 'leo'],
  ['margaret', 'maggie', 'meg', 'peggy', 'madge', 'marge', 'midge', 'rita'],
  ['matthew', 'matt', 'matty'],
  ['michael', 'mike', 'mick', 'mikey'],
  ['michelle', 'shelly', 'mich'],
  ['nathan', 'nate', 'nat'],
  ['nathaniel', 'nate', 'nat', 'than'],
  ['nicholas', 'nick', 'nicky', 'cole'],
  ['olivia', 'liv', 'livvy', 'ollie'],
  ['patrick', 'pat', 'paddy', 'rick'],
  ['patricia', 'pat', 'patty', 'tricia', 'trish'],
  ['peter', 'pete'],
  ['philip', 'phil'],
  ['phillip', 'phil'],
  ['rebecca', 'becca', 'becky', 'reba'],
  ['richard', 'rick', 'rich', 'dick', 'ricky', 'rico'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie', 'rocco'],
  ['ronald', 'ron', 'ronnie'],
  ['russell', 'russ'],
  ['samantha', 'sam', 'sammie', 'sammy'],
  ['samuel', 'sam', 'sammy'],
  ['sarah', 'sadie', 'sally'],
  ['sara', 'sadie'],
  ['stephanie', 'steph', 'stephie'],
  ['stephen', 'steve', 'stevie'],
  ['steven', 'steve', 'stevie'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['susanna', 'sue', 'susie', 'suzy', 'anna'],
  ['susannah', 'sue', 'susie', 'suzy'],
  ['theresa', 'terry', 'tess', 'tessa'],
  ['teresa', 'terry', 'tess', 'tessa'],
  ['thomas', 'tom', 'tommy'],
  ['timothy', 'tim', 'timmy', 'timo', 'timbo'],
  ['victoria', 'vicky', 'vic', 'tori'],
  ['vincent', 'vince', 'vinny'],
  ['walter', 'walt', 'wally'],
  ['william', 'will', 'bill', 'willy', 'billy', 'liam'],
  ['zachary', 'zach', 'zack', 'zac'],

  // ---- Spanish (~50) -----------------------------------------------------
  ['alejandro', 'alex', 'ale', 'jandro'],
  ['alejandra', 'ale', 'aleja'],
  ['ana', 'anita'],
  ['antonio', 'tony', 'toño'],
  ['antonia', 'toña', 'tona'],
  ['beatriz', 'bea', 'beti'],
  ['carlos', 'carlitos', 'carlo'],
  ['carmen', 'carmencita', 'carmelita'],
  ['daniela', 'dani'],
  ['eduardo', 'edu', 'eddie', 'lalo'],
  ['enrique', 'quique', 'kique'],
  ['ernesto', 'neto', 'tito'],
  ['esteban', 'tebi'],
  ['fernando', 'fer', 'nando'],
  ['fernanda', 'fer', 'nanda'],
  ['francisco', 'paco', 'pancho', 'fran', 'curro', 'kiko'],
  ['francisca', 'pancha', 'fran', 'paqui'],
  ['gabriela', 'gaby'],
  ['guillermo', 'guille', 'memo'],
  ['ignacio', 'nacho'],
  ['isabel', 'isa', 'chabela', 'belita'],
  ['javier', 'javi'],
  ['jesús', 'chuy', 'chucho', 'jesus'],
  ['joaquín', 'quim', 'joaco'],
  ['jorge', 'coque'],
  ['josé', 'pepe', 'jose'],
  ['josefina', 'pepa', 'fina'],
  ['juan', 'juancho', 'juanito'],
  ['leonardo', 'leo'],
  ['luis', 'lucho', 'lui'],
  ['luisa', 'luchi'],
  ['manuel', 'manu', 'manolo', 'lolo'],
  ['manuela', 'manu', 'manola'],
  ['margarita', 'marga', 'rita'],
  ['maría', 'mari', 'mary', 'maru', 'maria'],
  ['mauricio', 'mau', 'mauri'],
  ['miguel', 'migue', 'micky'],
  ['monserrat', 'montse', 'monse'],
  ['patricia', 'patty', 'patri'],
  ['pedro', 'peyo', 'perico'],
  ['rafael', 'rafa', 'rafi'],
  ['ricardo', 'ricky', 'rica', 'richi'],
  ['roberto', 'beto', 'rober', 'tito'],
  ['rodrigo', 'rodri'],
  ['rosa', 'rosita'],
  ['santiago', 'santi', 'chago'],
  ['sebastián', 'seba', 'sebas', 'sebastian'],
  ['tomás', 'tomy', 'tomi', 'tomas'],
  ['víctor', 'vic', 'victor'],
  ['ximena', 'xime', 'mena'],

  // ---- South-Asian (~70) -------------------------------------------------
  // Mix of Hindi, Punjabi, Tamil, Bengali, Gujarati short forms. Many
  // people use multiple short forms; the doctrine is "if either appears
  // in either record, treat as the same first name with exact last name".
  ['aakash', 'akash', 'ak'],
  ['aarav', 'arav', 'aaru'],
  ['aaron', 'ari'],
  ['abhinav', 'abhi'],
  ['abhishek', 'abhi', 'shek'],
  ['aditi', 'adi'],
  ['aditya', 'adi'],
  ['ajay', 'aj'],
  ['akshay', 'aksh', 'aki'],
  ['amit', 'amu'],
  ['anand', 'andy', 'anu'],
  ['ananya', 'anu', 'ana'],
  ['ankit', 'anki'],
  ['anjali', 'anju'],
  ['arjun', 'arju', 'jun'],
  ['arpita', 'arpi'],
  ['arvind', 'arvi'],
  ['ashish', 'ash'],
  ['ashok', 'ash'],
  ['avinash', 'avi'],
  ['ayesha', 'aysh'],
  ['bhavana', 'bhav', 'bhavi'],
  ['chandni', 'chand'],
  ['deepa', 'dee', 'deepu'],
  ['deepak', 'deep', 'dee'],
  ['deepika', 'deepi', 'dee'],
  ['devika', 'devi'],
  ['dhruv', 'dhru'],
  ['divya', 'divi'],
  ['gaurav', 'gauri', 'gau'],
  ['hari', 'haris', 'hary'],
  ['harish', 'haru'],
  ['ishaan', 'ish'],
  ['jay', 'jaya'],
  ['kavita', 'kavi'],
  ['krishna', 'kris', 'kishore', 'kanha'],
  ['lakshmi', 'lux', 'lakshmibai'],
  ['lavanya', 'lavi'],
  ['mahesh', 'mahi'],
  ['manisha', 'mani'],
  ['meena', 'mini'],
  ['meera', 'meeru'],
  ['mohan', 'mohi'],
  ['naveen', 'navi'],
  ['neha', 'nehu'],
  ['nikhil', 'nik', 'nikki'],
  ['nisha', 'nishi'],
  ['parvati', 'paro'],
  ['pooja', 'pooj'],
  ['prakash', 'prakhu', 'pk'],
  ['pranav', 'pranu'],
  ['priya', 'pri', 'priyu'],
  ['priyanka', 'pri', 'priya'],
  ['radha', 'radhu'],
  ['rahul', 'raul', 'rocky'],
  ['raj', 'raja'],
  ['rajesh', 'raj', 'rajju'],
  ['ramesh', 'ram', 'rami'],
  ['rashmi', 'rash'],
  ['ravi', 'ravu'],
  ['rekha', 'rekhu'],
  ['rohan', 'ro', 'rohi'],
  ['rohit', 'rohi'],
  ['sachin', 'sachi'],
  ['sandeep', 'sandy', 'sandhu'],
  ['sanjay', 'sanju', 'sajju'],
  ['saurabh', 'sourabh', 'sau'],
  ['shalini', 'shali'],
  ['shankar', 'shanky'],
  ['shilpa', 'shilu'],
  ['shreya', 'shree'],
  ['shruti', 'shru'],
  ['siddharth', 'sid', 'sidd'],
  ['smita', 'smi'],
  ['sneha', 'snehu'],
  ['soumya', 'sou'],
  ['srikanth', 'sri'],
  ['subash', 'subi'],
  ['sudha', 'sudhi'],
  ['suman', 'sumi'],
  ['sumit', 'sumi'],
  ['sunita', 'suni'],
  ['suresh', 'suri'],
  ['swati', 'swatu'],
  ['tanvi', 'tan'],
  ['vandana', 'vandu', 'vandi'],
  ['varun', 'varu'],
  ['vasudha', 'vasu'],
  ['venkat', 'venkatesh', 'venky'],
  ['vidya', 'vidu'],
  ['vijay', 'viju'],
  ['vikram', 'vikku', 'vik'],
  ['vinay', 'vinu'],
  ['vivek', 'viv'],
  ['yogesh', 'yogi'],
]

// ---------------------------------------------------------------------------
// Build the bidirectional alias map at module load.
// ---------------------------------------------------------------------------

const ALIASES_BY_NAME = new Map<string, Set<string>>()

for (const group of NICKNAME_GROUPS) {
  const set = new Set(group.map((n) => n.toLowerCase()))
  for (const name of set) {
    let existing = ALIASES_BY_NAME.get(name)
    if (!existing) {
      existing = new Set()
      ALIASES_BY_NAME.set(name, existing)
    }
    for (const alias of set) existing.add(alias)
  }
}

/**
 * All names equivalent to `name` (case-insensitive), including `name`
 * itself. Returns a singleton set with just the lowercased input when
 * the name has no known aliases.
 */
export function nicknamesFor(name: string | null | undefined): Set<string> {
  if (!name) return new Set()
  const norm = name.trim().toLowerCase()
  if (!norm) return new Set()
  return ALIASES_BY_NAME.get(norm) ?? new Set([norm])
}

/**
 * Are these two first names equivalent under the nickname dictionary?
 * Returns true when they are case-insensitively equal OR share an entry
 * in NICKNAME_GROUPS.
 *
 * Cascade stage 3 uses this with an EXACT last-name check on the side.
 * The dictionary alone is not a couple match — only `nicknameEquivalent
 * + exact last name` is.
 */
export function nicknameEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false
  const na = a.trim().toLowerCase()
  const nb = b.trim().toLowerCase()
  if (!na || !nb) return false
  if (na === nb) return true
  const aliases = ALIASES_BY_NAME.get(na)
  if (!aliases) return false
  return aliases.has(nb)
}

/**
 * The set of every name token the dictionary knows. Used by the email-
 * localpart extractor for greedy segmentation.
 */
export function knownNameTokens(): Set<string> {
  return new Set(ALIASES_BY_NAME.keys())
}
