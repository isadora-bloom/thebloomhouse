// SessionStart hook: lists open pull requests on GitHub so Claude raises them
// at the start of the session. Isadora and Phil both work in this repo, and a
// PR one of them (or a Claude session) opens only gets noticed if someone goes
// looking. Whatever this prints is added to the session's context.
//
// Needs the GitHub CLI (`gh`) signed in. If it isn't, this says so instead,
// so Claude can tell the person to check the Pull requests tab themselves.
import { execFileSync } from 'node:child_process'

const REPO = 'isadora-bloom/thebloomhouse'
const PULLS_URL = `https://github.com/${REPO}/pulls`

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

try {
  let prs
  try {
    prs = JSON.parse(
      gh([
        'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '30',
        '--json', 'number,title,url,author,headRefName,baseRefName,createdAt,isDraft,reviewRequests',
      ]),
    )
  } catch {
    console.log('# Open pull requests\n')
    console.log(
      `Couldn't check GitHub for open pull requests (the gh CLI is missing or not signed in). ` +
        `In your first reply, tell the user this in one line and point them to ${PULLS_URL}, ` +
        `and mention that running \`gh auth login\` once would let you check for them.`,
    )
    process.exit(0)
  }

  if (prs.length === 0) process.exit(0)

  let me = ''
  try {
    me = gh(['api', 'user', '--jq', '.login']).trim()
  } catch {
    // Not knowing who is signed in only loses the "yours / not yours" split.
  }

  console.log('# Open pull requests\n')
  console.log(
    'Before anything else in your first reply, tell the user about these open pull requests in plain words: ' +
      'what each one changes, who opened it, and whether it is waiting on them. Put the ones they did not open first, ' +
      'and give the link. Keep it short. Then carry on with what they asked.\n',
  )
  if (me) console.log(`Signed in to GitHub as: ${me}\n`)

  for (const pr of prs) {
    const author = pr.author?.login ?? 'unknown'
    const reviewers = (pr.reviewRequests ?? []).map((r) => r.login ?? r.name).filter(Boolean)
    const tags = []
    if (me && author !== me) tags.push('not opened by you')
    if (me && reviewers.includes(me)) tags.push('your review is requested')
    if (pr.isDraft) tags.push('draft')
    console.log(
      `- #${pr.number} ${pr.title}\n` +
        `  ${pr.headRefName} -> ${pr.baseRefName}, opened by ${author} on ${pr.createdAt.slice(0, 10)}` +
        (reviewers.length ? `, reviewers: ${reviewers.join(', ')}` : '') +
        (tags.length ? ` [${tags.join('; ')}]` : '') +
        `\n  ${pr.url}`,
    )
  }
} catch {
  // Never block a session over this.
  process.exit(0)
}
