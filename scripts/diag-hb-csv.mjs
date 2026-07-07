import { readFileSync } from 'node:fs'

const csv = readFileSync('C:/Users/Ismar/Downloads/June-2023-Booked Client-report-(HoneyBook).csv', 'utf8')
const lines = csv.split('\n').filter(l => l.trim())
const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
console.log('headers:', header)

const bookingIdx = header.findIndex(h => /booked?\s*date|date\s*booked|booking\s*date|contract\s*signed/i.test(h))
const statusIdx = header.findIndex(h => /project\s*status/i.test(h))
console.log('booking col idx:', bookingIdx, '=', header[bookingIdx])
console.log('status col idx:', statusIdx, statusIdx >= 0 ? '= ' + header[statusIdx] : '(not present)')

let hasBooking = 0, noBooking = 0
for (const line of lines.slice(1)) {
  const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
  const booking = bookingIdx >= 0 ? cols[bookingIdx] : null
  if (booking) hasBooking++; else noBooking++
}
console.log(`rows with booking date: ${hasBooking}`)
console.log(`rows without booking date: ${noBooking}`)
console.log(`\nfirst 5 rows:`)
for (const line of lines.slice(1, 6)) {
  const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
  const obj = {}
  header.forEach((h, i) => { obj[h] = cols[i] })
  console.log(JSON.stringify({ Email: obj['Email'], 'Project Name': obj['Project Name'], 'Booked Date': obj['Booked Date'], 'Project Creation Date': obj['Project Creation Date'] }))
}
