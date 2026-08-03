# Getting Phil Access — The Bloom House

Operator checklist for Isadora. Work top to bottom. Phil is technical (he wrote the
Agent in Python/FastAPI), so grant real access, not read-only viewer seats, wherever
he needs to run and change things.

**Rule for every secret below:** never paste keys into chat, email, or a text.
Put them in a shared 1Password vault (or send via a one-time link like
onetimesecret.com). Keys pasted into a message should be treated as burned and rotated.

---

## The 5-minute version (do this first)

The code is already on GitHub at `github.com/isadora-bloom/thebloomhouse`. Most of
setup is just inviting Phil in.

**Share GitHub (you, once):**
1. Repo on github.com → **Settings** → **Collaborators**.
2. Add Phil's GitHub username. He accepts the email invite.

**Share Supabase (you, once):**
1. Supabase dashboard → the project → **Settings** → **Team** → **Invite**.
2. Enter Phil's email.

**Phil runs on his machine:**
```bash
git clone https://github.com/isadora-bloom/thebloomhouse.git
cd thebloomhouse
npm install
npm run dev          # http://localhost:3000
```
He also needs the secret keys for `.env.local` — drop them in the shared vault.

**The one rule for working in parallel:** you each work on your **own branch**, never
on `main` directly. Phil: `git checkout -b phil/whatever`. You: your own branch. When a
piece is done, open a Pull Request to merge it. That way you never overwrite each other.

**Know this:** you share **one** database (the same Supabase). Normal and fine, but a
wipe or big change hits you both, so keep destructive steps (like the Phase 2 wipe)
coordinated.

The rest of this doc is the fuller detail if you need it.

---

## 1. Source control (GitHub)

The consolidation target and the four source codebases.

| Repo | What it is | Access to grant |
|------|-----------|-----------------|
| `isadora-bloom/thebloomhouse` | Main repo, the consolidation target | **Write** (collaborator or team member) |
| `bloom-agent-main` | Phil's Agent (Python/FastAPI) | He likely owns this already. Confirm. |
| `bloom` | Intelligence (Next.js/tRPC) | **Read** |
| `bloom-house-portal` | Portal (React/Express) | **Read** |
| `rixey-portal` | Original Rixey portal | **Read** |

Steps:
1. If there's a GitHub org (`isadora-bloom`), add Phil to a team and give the team
   Write on `thebloomhouse`, Read on the three reference repos. Teams beat
   per-repo invites because you manage it in one place.
2. If the three reference repos are local-only and not on GitHub, zip them or push
   them to private repos first. Phil needs them to port logic across.
3. Get his GitHub username before you start.

---

## 2. Database (Supabase)

Two things matter here: the live Bloom House project, and the source projects the
data is being migrated from.

1. **Bloom House project** (`jsxxgwprxuqgcauzlxcb`): invite Phil as a member.
   Settings → Team → Invite. Give **Developer** or **Admin** (Admin if he'll run
   migrations and manage the schema, which the ingestion work needs).
2. **Source projects** (any older Bloom/Rixey Supabase projects the historical data
   lives in): at least **read** access so he can see what's being migrated from.
3. **Service role key:** this is the god key (bypasses RLS). It goes in the vault,
   not a message. Remind him it's data-plane only, no DDL, so schema changes still
   go through migrations.

---

## 3. Hosting (Vercel)

1. Add Phil to the Vercel team that owns the Bloom House project.
2. Give him access to Preview and Production deployments and, importantly, the
   **environment variables** screen. Env is the cleanest way for him to pull real
   config: `vercel env pull` beats you hand-copying keys.
3. Confirm which branch is production before he pushes anything.

---

## 4. AI + third-party API keys

Everything in `.env.local.example` he'll need a real value for. Grouped by what the
ingestion/backfill work actually touches first:

**Core (needed day one):**
- `ANTHROPIC_API_KEY` — add him to the Anthropic Console org, or issue him his own
  key under a workspace so usage is attributable to him.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` — from the Supabase project (section 2).
- `OPENAI_API_KEY` — fallback provider, gated by circuit breaker.

**Ingestion sources (needed for the backfill):**
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` — Gmail
  ingestion. He'll need access to the Google Cloud project that owns the OAuth
  client. Add him as an editor on that GCP project.
- `CALENDLY_API_TOKEN` / `CALENDLY_OAUTH_CLIENT_ID` / `CALENDLY_OAUTH_CLIENT_SECRET`
  / `CALENDLY_WEBHOOK_SECRET` — Calendly meetings feed.
- `RESEND_API_KEY` / `EMAIL_FROM` — outbound email.
- `ZOOM_*` — meeting capture, if in scope.

**Secondary data APIs (not blocking):**
- `FRED_API_KEY`, `NOAA_CDO_TOKEN`, `SERPAPI_API_KEY`, `CENSUS_API_KEY` — external
  context / intelligence loop. Can wait.

**Billing:**
- `STRIPE_*` — only if he's touching billing. Otherwise skip for now.

---

## 5. Data sources for the backfill (the actual step one)

This is separate from code access. Phil needs the raw data to work back from.

1. **HoneyBook** — the CSV of all booked clients is the first anchor. Either:
   - export it yourself and drop it in the vault / a shared drive, or
   - add Phil to HoneyBook so he can pull exports himself.
   Decide which. Self-serve is less back-and-forth long term.
2. **Calendly** — API token (section 4) covers this, so no separate export needed
   once he's got the key.
3. **Calculator** — where do calculator submissions currently land? If it's a
   Supabase table, section 2 covers it. If it's a spreadsheet or a form tool,
   he needs access to that source.
4. **Email + text corpus** — Gmail is via OAuth (section 4). For text/SMS, tell him
   which number and which provider the texts live in, and get him access to export
   or read them. (There's no SMS provider key in the env yet, so this one needs a
   decision.)

---

## 6. Local dev setup (send Phil this)

```bash
git clone <thebloomhouse repo url>
cd thebloomhouse
cp .env.local.example .env.local   # then fill from the vault, or: vercel env pull
npm install
npm run dev                        # http://localhost:3000
```

Demo mode is cookie-based: visit `/demo` to explore without touching real data.

---

## 7. Read-first docs (point him at these, in order)

1. `CLAUDE.md` — repo orientation, structure, commands.
2. `CONSOLIDATION-PLAN-PHASED.md` — the plan of record.
3. `BLUEPRINT.md` — architecture, schema, what NOT to build.
4. `INGESTION-BACKFILL-DOCTRINE.md` — his actual starting brief (being written next).
5. `IDENTITY-FIRST-ARCHITECTURE.md` — how identity resolution works, the core of the
   ingestion problem.

---

## Quick order of operations

1. Get his GitHub username + the email for his Google/Anthropic/Supabase invites.
2. GitHub team + repo access.
3. Supabase invite.
4. Vercel invite.
5. Google Cloud project invite (for Gmail OAuth).
6. Drop all keys + the HoneyBook CSV in the shared vault.
7. Send him the section 6 setup block and the section 7 reading list.
