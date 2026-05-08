# Compliance docs

Tier-C compliance + ops references. Linked from Tier-C launch plan
items #119, #120, #122, #127, #131. Lives in repo so a regulator,
CISO, or insurance underwriter request can be served without hunting
through Notion.

| Doc | Tier-C item | What it covers |
|---|---|---|
| `data-region-and-scc.md` | #119 | Where customer data physically lives + transfer mechanism for non-US data subjects |
| `breach-notification-runbook.md` | #120 | State-by-state PII breach notification timing for VA + NC; default fall-back for all other states |
| `dpa-reference.md` | #122 | Sub-processor list with DPA links + categories of personal data shared |
| `vendor-security-review.md` | #127 | Bloom House security posture summary, intended for prospective customers asking "how secure are you?" |
| `vulnerability-management.md` | #131 | Scanning + pen-test cadence, dependency monitoring, and our patch SLA |
| `sla.md` | #137 | Uptime + support response commitments for multi / enterprise customers. Default contract; per-customer MSA can override. |

These are reference docs, not playbooks. For active-incident
playbooks see `INCIDENT.md` at the repo root. For day-to-day ops see
`OPS.md`.

## Review cadence

Each doc carries a "Last reviewed" date in its header. Review on the
**same calendar quarter cadence** unless the underlying fact (a
sub-processor, a hosting region, a state PII law) changes earlier. A
single source-of-truth grep for "Last reviewed" across this folder is
the audit-trail for "did you keep these current?"

```bash
grep -r "Last reviewed:" docs/compliance/
```
