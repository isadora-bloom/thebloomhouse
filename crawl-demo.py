"""Crawl all /demo/* pages and extract visible text for audit."""
import urllib.request
import json
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://bloom-house-iota.vercel.app"

PAGES = {
    "AGENT": [
        "/demo/agent/inbox",
        "/demo/agent/pipeline",
        "/demo/agent/leads",
        "/demo/agent/drafts",
        "/demo/agent/sequences",
        "/demo/agent/relationships",
        "/demo/agent/analytics",
        "/demo/agent/codes",
        "/demo/agent/errors",
        "/demo/agent/knowledge-gaps",
        "/demo/agent/learning",
        "/demo/agent/notifications",
        "/demo/agent/rules",
        "/demo/agent/settings",
    ],
    "INTEL": [
        "/demo/intel/dashboard",
        "/demo/intel/briefings",
        "/demo/intel/clients",
        "/demo/intel/tours",
        "/demo/intel/reviews",
        "/demo/intel/campaigns",
        "/demo/intel/capacity",
        "/demo/intel/company",
        "/demo/intel/cross",
        "/demo/intel/forecasts",
        "/demo/intel/health",
        "/demo/intel/lost-deals",
        "/demo/intel/market-pulse",
        "/demo/intel/matching",
        "/demo/intel/nlq",
        "/demo/intel/portfolio",
        "/demo/intel/regions",
        "/demo/intel/social",
        "/demo/intel/sources",
        "/demo/intel/team",
        "/demo/intel/team-compare",
        "/demo/intel/trends",
        "/demo/intel/annotations",
    ],
    "PORTAL": [
        "/demo/portal/weddings",
        "/demo/portal/bar-config",
        "/demo/portal/checklist-config",
        "/demo/portal/decor-config",
        "/demo/portal/guest-care-config",
        "/demo/portal/kb",
        "/demo/portal/messages",
        "/demo/portal/rehearsal-config",
        "/demo/portal/rooms-config",
        "/demo/portal/sage-queue",
        "/demo/portal/seating-config",
        "/demo/portal/section-settings",
        "/demo/portal/shuttle-config",
        "/demo/portal/staffing-config",
        "/demo/portal/tables-config",
        "/demo/portal/vendors",
        "/demo/portal/wedding-details-config",
    ],
    "COUPLE PORTAL": [
        "/demo/couple/hawthorne-manor",
        "/demo/couple/hawthorne-manor/getting-started",
        "/demo/couple/hawthorne-manor/chat",
        "/demo/couple/hawthorne-manor/messages",
        "/demo/couple/hawthorne-manor/checklist",
        "/demo/couple/hawthorne-manor/timeline",
        "/demo/couple/hawthorne-manor/budget",
        "/demo/couple/hawthorne-manor/contracts",
        "/demo/couple/hawthorne-manor/guests",
        "/demo/couple/hawthorne-manor/rsvp-settings",
        "/demo/couple/hawthorne-manor/seating",
        "/demo/couple/hawthorne-manor/tables",
        "/demo/couple/hawthorne-manor/party",
        "/demo/couple/hawthorne-manor/ceremony",
        "/demo/couple/hawthorne-manor/rehearsal",
        "/demo/couple/hawthorne-manor/bar",
        "/demo/couple/hawthorne-manor/decor",
        "/demo/couple/hawthorne-manor/photos",
        "/demo/couple/hawthorne-manor/couple-photo",
        "/demo/couple/hawthorne-manor/inspo",
        "/demo/couple/hawthorne-manor/picks",
        "/demo/couple/hawthorne-manor/beauty",
        "/demo/couple/hawthorne-manor/vendors",
        "/demo/couple/hawthorne-manor/preferred-vendors",
        "/demo/couple/hawthorne-manor/rooms",
        "/demo/couple/hawthorne-manor/stays",
        "/demo/couple/hawthorne-manor/transportation",
        "/demo/couple/hawthorne-manor/allergies",
        "/demo/couple/hawthorne-manor/guest-care",
        "/demo/couple/hawthorne-manor/staffing",
        "/demo/couple/hawthorne-manor/venue-inventory",
        "/demo/couple/hawthorne-manor/wedding-details",
        "/demo/couple/hawthorne-manor/worksheets",
        "/demo/couple/hawthorne-manor/downloads",
        "/demo/couple/hawthorne-manor/resources",
        "/demo/couple/hawthorne-manor/website",
        "/demo/couple/hawthorne-manor/booking",
        "/demo/couple/hawthorne-manor/final-review",
    ],
    "SETTINGS & ADMIN": [
        "/demo/settings",
        "/demo/settings/personality",
        "/demo/settings/voice",
        "/demo/onboarding",
        "/demo/super-admin",
    ],
    "SPECIAL": [
        "/demo",
    ],
}


class TextExtractor(HTMLParser):
    """Extract visible text from HTML, skipping script/style/svg."""
    SKIP = {"script", "style", "svg", "noscript", "head"}

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            text = data.strip()
            if text:
                self.parts.append(text)


def fetch_page(path):
    url = BASE + path
    req = urllib.request.Request(url, headers={"User-Agent": "BloomHouseAudit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.status
            html = resp.read().decode("utf-8", errors="replace")
        ext = TextExtractor()
        ext.feed(html)
        # Deduplicate consecutive identical lines
        lines = []
        for p in ext.parts:
            if not lines or lines[-1] != p:
                lines.append(p)
        text = "\n".join(lines)
        # Truncate very long pages to keep report manageable
        if len(text) > 3000:
            text = text[:3000] + "\n... [truncated]"
        return path, status, text
    except Exception as e:
        return path, 0, f"ERROR: {e}"


def main():
    all_paths = []
    for section, paths in PAGES.items():
        all_paths.extend([(section, p) for p in paths])

    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_page, p): (s, p) for s, p in all_paths}
        for fut in as_completed(futures):
            section, path = futures[fut]
            path, status, text = fut.result()
            results.setdefault(section, []).append((path, status, text))

    # Sort each section by path
    for section in results:
        results[section].sort(key=lambda x: x[0])

    # Write report
    out = []
    out.append("# Bloom House Demo Crawl Report")
    out.append(f"# Base: {BASE}")
    out.append(f"# Total pages: {sum(len(v) for v in results.values())}")
    out.append("")

    section_order = ["AGENT", "INTEL", "PORTAL", "COUPLE PORTAL", "SETTINGS & ADMIN", "SPECIAL"]
    for section in section_order:
        pages = results.get(section, [])
        out.append(f"\n{'='*80}")
        out.append(f"## {section} ({len(pages)} pages)")
        out.append(f"{'='*80}\n")
        for path, status, text in pages:
            out.append(f"### {path}")
            out.append(f"Status: {status}")
            out.append(f"{'─'*60}")
            out.append(text)
            out.append(f"{'─'*60}\n")

    report = "\n".join(out)
    with open("DEMO-CRAWL-REPORT.md", "w", encoding="utf-8") as f:
        f.write(report)
    print(f"Done. {sum(len(v) for v in results.values())} pages crawled.")
    # Print status summary
    for section in section_order:
        pages = results.get(section, [])
        ok = sum(1 for _, s, _ in pages if s == 200)
        fail = len(pages) - ok
        print(f"  {section}: {ok} OK, {fail} failed")


if __name__ == "__main__":
    main()
