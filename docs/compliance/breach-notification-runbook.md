# PII breach notification runbook

**Tier-C #120**
**Owner:** Isadora Martin-Dye
**Last reviewed:** 2026-05-08

---

This is the playbook for the regulatory-notification side of a data
incident. The technical-response side lives in `INCIDENT.md` at the
repo root — that's the thing you reach for during the incident itself.
This is what you reach for after triage, when the question is *who do
we have to tell, and by when*.

---

## Step 0 — confirm it qualifies as PII

Not every leak is a "PII breach" under state law. The trigger is
typically **unauthorised access to "personal information"** as defined
by that state. The federal commonality across most states:

- Name + (SSN | driver's license | financial account | medical | biometric)
- Increasingly: name + email + password (where the password could be
  used to access another service)

What Bloom House actually holds:

| Field | PII under VA | PII under NC | Notes |
|---|---|---|---|
| Couple name | No (alone) | No (alone) | Combined with another field below = PII |
| Couple email | No (alone) | No (alone) | But name+email is "personal info" under most states |
| Couple phone | No (alone) | No (alone) | Same combination rule |
| Wedding date | No | No | Not regulated PII |
| Wedding venue / address | No | No | Not regulated PII |
| Guest list with addresses | **Yes** | **Yes** | Name + address combination |
| Vendor contracts (PDF) | **Maybe** | **Maybe** | Depends on contract content; budget figures alone are not PII |
| Coordinator login email + password hash | **Yes** | **Yes** | Even hashed credentials trigger notification in most states if name is exposed |
| Stripe data | n/a | n/a | We never hold card data; if Stripe has a breach, it's their notification |
| OAuth refresh tokens (Gmail) | **Yes** | **Yes** | Treat as credentials |

**Default rule:** if you cannot confidently say "this is not PII",
treat it as PII and follow the runbook. The cost of over-reporting is
small. The cost of under-reporting under VA/NC law includes per-record
penalties.

---

## Virginia — Va. Code § 18.2-186.6

**Who must be notified:** any Virginia resident whose **unencrypted**
"personal information" was accessed by an unauthorised person.

**Encryption defense:** if the accessed data was encrypted at rest AND
the encryption key was not also accessed, the law provides a safe
harbour. Bloom holds Supabase data in encrypted-at-rest form by
default. The risk-relevant question becomes: **was the service-role
key (or a coordinator session token) also exposed?**

**Timing:** "without unreasonable delay" — Virginia does not name a
hard number, but practical interpretation is **within 30 days** of
confirming the breach.

**Format:** written notice OR email (if email is the customer's
ordinary contact channel). Bloom uses email because that's how the
service is delivered.

**Notify the AG:** if more than 1,000 Virginia residents are affected,
notify the Office of the Attorney General **and** notify nationwide
consumer reporting agencies (Equifax, Experian, TransUnion).

**Substitute notice path:** if direct notice would cost more than
$50,000 OR affect more than 100,000 residents, substitute notice (web
posting + statewide media + AG notice) is permitted.

---

## North Carolina — N.C.G.S. § 75-65

**Who must be notified:** any North Carolina resident whose
"personal information" was accessed.

**Encryption defense:** same as Virginia — encrypted data is exempt
unless the key was also compromised.

**Timing:** "without unreasonable delay" — NC interprets this more
strictly than VA in practice. **Default to 30 days from confirmation,
shorter if you can.**

**Notify the AG:** all breaches affecting NC residents must be reported
to the AG's Consumer Protection Division regardless of count. The
report uses the AG's online breach notification form.

**Format:** written notice; email permitted only if the customer has
agreed to electronic notice in advance. **Bloom's terms of service
must explicitly opt customers into electronic-notice for breach
purposes** — verify with `/legal/terms` content before the first
incident.

**Notice content (mandatory in NC):**
- Description of the incident in general terms
- Type of personal information involved
- General description of what we did to protect data
- Phone number a recipient can call for more info
- Advice to remain vigilant + monitor credit reports

---

## All other states — default fall-back

Bloom House operates predominantly in VA and NC today. As we onboard
venues across state lines, the breach response defaults to a
**superset notice** that satisfies the strictest of the affected
states. The states with the tightest notification windows are
**Florida (30 days) and Colorado (30 days)** — design every
notification to ship within 30 days from confirmation and you are
clean on every state we are likely to touch.

For an authoritative state-by-state lookup at the moment of incident,
the National Conference of State Legislatures maintains a current
comparison: <https://www.ncsl.org/technology-and-communication/security-breach-notification-laws>.

The IAPP also publishes a free lookup; cross-reference both at
incident time.

---

## The decision tree, in two minutes

```
  Was unauthorised access confirmed?
           │
           ▼
   Was encrypted data the only thing accessed?
       ├── Yes, AND key not exposed   → Document + close. No notification required.
       └── No, OR key exposed         → Continue.
           │
           ▼
   Identify affected residents by state.
           │
           ▼
   Pull list of distinct states from `interactions` joined to
   `weddings` joined to `venues.state`.
           │
           ▼
   For each state:
       ├── Determine count
       ├── Determine notification deadline (default 30d)
       ├── Determine AG notice trigger (always for NC; >1000 for VA)
       └── Draft notice using state's mandatory content elements.
           │
           ▼
   Send notice.
           │
           ▼
   File AG report where required.
           │
           ▼
   Update INCIDENT log + this runbook with what we learned.
```

---

## Templates

Notice templates live at `/legal/breach-notice-templates/` (TBD —
create on first incident; use the IAPP free templates as a starting
point). Templates should leave blanks for:

- Date breach was discovered
- Date breach occurred (if known) or "exact date undetermined"
- Categories of data accessed
- Number of records (per-state)
- Steps taken to remediate
- What the affected user should do
- Contact phone + email for the affected user

---

## Cross-references

- `INCIDENT.md` — active-incident technical playbook
- `dpa-reference.md` — sub-processor list (a sub-processor breach is
  still our customer-facing breach)
- `data-region-and-scc.md` — where data physically lives (relevant
  for cross-state attribution)
- `OPS.md` — primary-table coverage matrix (helps quickly identify
  what data was touched)
