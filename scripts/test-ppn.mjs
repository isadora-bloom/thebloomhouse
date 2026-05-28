function strip(t) { return t.replace(/['’][sS]$/u, '') }
function ppn(raw) {
  let s = raw.trim().replace(/\b(wedding|event|reception|ceremony|nuptials)\b\s*$/i, '').trim()
  s = strip(s).trim()
  const sm = s.split(/\s+(?:&|and|\+)\s+/i)
  if (sm.length === 2) {
    const lt = sm[0].trim().split(/\s+/).map(strip).filter(Boolean)
    const rt = sm[1].trim().split(/\s+/).map(strip).filter(Boolean)
    return { p1: lt, p2: rt }
  }
  return { single: s.split(/\s+/).map(strip) }
}
const names = [
  "Carmen and Tae’s Wedding",
  "Carmen & Tae's Wedding",
  "Tae's Wedding",
  "Caitlin Gibney's & Kajlie's Wedding",
  "Aidan's & Gabrielle Wedding",
  "Emily & Francisco's Wedding",
  "Kevin's & Ashley Wedding",
]
for (const n of names) console.log(JSON.stringify(n), '=>', JSON.stringify(ppn(n)))
