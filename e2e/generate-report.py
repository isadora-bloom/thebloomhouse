"""Generate audit report from Playwright JSON results."""
import json, sys, os
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

RESULTS = os.path.join(os.path.dirname(__file__), 'results.json')
OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'DEMO-AUDIT-REPORT.md')

with open(RESULTS, encoding='utf-8') as f:
    data = json.load(f)

# Extract all tests
tests = []

def walk_suites(suite, section=''):
    sec = suite.get('title') or section
    for spec in suite.get('specs', []):
        for t in spec.get('tests', []):
            result = t['results'][0] if t.get('results') else {}
            annotations = result.get('annotations', [])
            issues = []
            for ann in annotations:
                if ann.get('type') == 'issues' and ann.get('description'):
                    issues = json.loads(ann['description'])
            tests.append({
                'section': sec,
                'name': spec['title'],
                'status': result.get('status', 'unknown'),
                'duration': result.get('duration', 0),
                'issues': issues,
                'errors': result.get('errors', []),
            })
    for child in suite.get('suites', []):
        walk_suites(child, sec)

for s in data['suites']:
    walk_suites(s)

# Group by section
from collections import OrderedDict
sections = OrderedDict()
for t in tests:
    sections.setdefault(t['section'], []).append(t)

# Build report
L = []
L.append('# Bloom House — Automated Demo Audit Report')
L.append(f'**Generated:** {datetime.now().strftime("%Y-%m-%d %H:%M")}')
L.append(f'**Target:** https://bloom-house-iota.vercel.app/demo/*')
L.append(f'**Method:** Playwright Chromium — full JS rendering, network monitoring, console capture')
L.append(f'**Total duration:** {data["stats"]["duration"]/1000:.0f}s')
L.append('')

total = len(tests)
passed = sum(1 for t in tests if t['status'] == 'passed')
failed = total - passed
with_issues = sum(1 for t in tests if len(t['issues']) > 0)
all_issues = [i for t in tests for i in t['issues']]

L.append('## Summary')
L.append('| Metric | Count |')
L.append('|--------|-------|')
L.append(f'| Total pages tested | {total} |')
L.append(f'| Passed (no critical issues) | {passed} |')
L.append(f'| Failed (critical issues) | {failed} |')
L.append(f'| Pages with warnings | {with_issues} |')
L.append(f'| Total issues found | {len(all_issues)} |')
L.append('')

L.append('## What Was Checked')
L.append('Each page was loaded in a real Chromium browser with full JavaScript execution:')
L.append('')
L.append('| Check | What it catches |')
L.append('|-------|----------------|')
L.append('| **Console errors** | Runtime JS crashes, unhandled promise rejections, failed imports |')
L.append('| **Bad text patterns** | Visible "undefined", "NaN", "null", "[object Object]", error messages, "Lorem ipsum" |')
L.append('| **Failed network requests** | Broken API calls (4xx/5xx), missing endpoints |')
L.append('| **Broken images** | Images that failed to load (naturalWidth === 0) |')
L.append('| **Empty pages** | Pages with < 20 characters of visible text (blank renders) |')
L.append('| **Screenshots** | Every page screenshotted for visual review |')
L.append('')

# Issue type counts
type_counts = {}
for i in all_issues:
    type_counts[i['type']] = type_counts.get(i['type'], 0) + 1

if type_counts:
    L.append('## Issue Breakdown by Type')
    L.append('| Type | Count | Severity |')
    L.append('|------|-------|----------|')
    severity = {
        'console-error': 'Medium',
        'bad-text': 'High',
        'failed-request': 'Medium-High',
        'broken-image': 'Medium',
        'empty-page': 'Critical',
    }
    for typ, cnt in sorted(type_counts.items(), key=lambda x: -x[1]):
        L.append(f'| {typ} | {cnt} | {severity.get(typ, "Unknown")} |')
    L.append('')

# Per-section detail
L.append('---')
L.append('')
L.append('## Detailed Results by Section')
L.append('')

for section, stests in sections.items():
    sp = sum(1 for t in stests if t['status'] == 'passed')
    sf = len(stests) - sp
    si = sum(1 for t in stests if t['issues'])

    status_str = f'{sp} passed'
    if sf > 0: status_str += f', {sf} failed'
    if si > 0: status_str += f', {si} with warnings'

    L.append(f'### {section} ({len(stests)} pages — {status_str})')
    L.append('')

    L.append('| Page | Status | Time | Issues |')
    L.append('|------|--------|------|--------|')
    for t in stests:
        icon = '✅' if t['status'] == 'passed' else '❌'
        dur = f'{t["duration"]/1000:.1f}s'
        ic = f'⚠️ {len(t["issues"])}' if t['issues'] else '—'
        L.append(f'| `{t["name"]}` | {icon} {t["status"]} | {dur} | {ic} |')
    L.append('')

    # Issue details for this section
    issues_in_section = [(t['name'], t['issues']) for t in stests if t['issues']]
    if issues_in_section:
        L.append(f'#### {section} — Issue Details')
        L.append('')
        for name, issues in issues_in_section:
            L.append(f'**`{name}`:**')
            for issue in issues:
                icon = {
                    'console-error': '🔴',
                    'bad-text': '🟡',
                    'failed-request': '🔴',
                    'broken-image': '🟠',
                    'empty-page': '⛔',
                }[issue['type']]
                L.append(f'- {icon} **{issue["type"]}**: {issue["detail"]}')
            L.append('')

# Deduplicate recurring issues
L.append('---')
L.append('')
L.append('## Recurring Issues (Deduplicated)')
L.append('')
L.append('These issues appear across multiple pages and likely share a root cause:')
L.append('')

from collections import Counter
issue_details = Counter()
issue_pages = {}
for t in tests:
    for i in t['issues']:
        key = (i['type'], i['detail'][:120])
        issue_details[key] += 1
        issue_pages.setdefault(key, []).append(t['name'])

recurring = [(k, v) for k, v in issue_details.items() if v >= 2]
recurring.sort(key=lambda x: -x[1])

if recurring:
    L.append('| # | Type | Detail | Pages Affected | Count |')
    L.append('|---|------|--------|----------------|-------|')
    for idx, ((typ, detail), count) in enumerate(recurring, 1):
        pages = issue_pages[(typ, detail)]
        page_str = ', '.join(pages[:5])
        if len(pages) > 5:
            page_str += f' +{len(pages)-5} more'
        L.append(f'| {idx} | `{typ}` | {detail} | {page_str} | {count} |')
    L.append('')
else:
    L.append('No recurring issues found.')
    L.append('')

# Clean pages
L.append('---')
L.append('')
L.append('## Clean Pages (No Issues Detected)')
L.append('')
clean = [t for t in tests if t['status'] == 'passed' and not t['issues']]
if clean:
    for t in clean:
        L.append(f'- ✅ {t["section"]} / `{t["name"]}`')
else:
    L.append('No completely clean pages — every page had at least one warning.')
L.append('')

# Manual review notes
L.append('---')
L.append('')
L.append('## Still Needs Manual Review')
L.append('')
L.append('Automated testing catches structural issues. These still need human eyes:')
L.append('')
L.append('- [ ] Charts/graphs render with real data (not empty containers)')
L.append('- [ ] Drag-and-drop interactions work (seating, timeline reordering)')
L.append('- [ ] Form submissions save and persist correctly')
L.append('- [ ] Sage AI chat responds coherently with venue voice')
L.append('- [ ] Cross-page data consistency (portal config ↔ couple portal display)')
L.append('- [ ] Mobile/tablet responsiveness across breakpoints')
L.append('- [ ] Correct venue branding per demo venue (not just Hawthorne Manor)')
L.append('- [ ] Print/PDF export functionality')
L.append('- [ ] Email notifications trigger correctly')
L.append('- [ ] Multi-venue scope switching works (Hawthorne → Crestwood → Glass House → Rose Hill)')
L.append('')
L.append('---')
L.append(f'*Screenshots saved to `test-results/` — one per page for visual walkthrough.*')

report = '\n'.join(L)
with open(OUTPUT, 'w', encoding='utf-8') as f:
    f.write(report)

print(f'Report written to {OUTPUT}')
print(f'{total} pages, {passed} passed, {failed} failed, {with_issues} with warnings, {len(all_issues)} total issues')
