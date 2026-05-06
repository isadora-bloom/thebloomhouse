/**
 * CSV export helper.
 *
 * Builds a CSV string from a set of columns and rows, then triggers a
 * browser download via a temporary anchor element. Prepends a UTF-8 BOM
 * so Excel treats the file as UTF-8 rather than the local Windows code
 * page (this preserves accented characters, emoji, etc).
 *
 * Quoting rules (RFC 4180-ish):
 *   - A field is wrapped in double quotes if it contains a comma,
 *     double quote, CR, or LF.
 *   - Internal double quotes are escaped by doubling them (" -> "").
 */

export interface CsvColumn {
  key: string
  label: string
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = typeof value === 'string' ? value : String(value)
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function buildCsv(
  columns: CsvColumn[],
  rows: Record<string, unknown>[]
): string {
  const header = columns.map((c) => escapeField(c.label)).join(',')
  const body = rows
    .map((row) => columns.map((c) => escapeField(row[c.key])).join(','))
    .join('\n')
  return body ? `${header}\n${body}` : header
}

export interface ExportToCsvOptions {
  /**
   * Logical resource being exported (e.g. 'guest_list', 'budget',
   * 'timeline'). Used as the audit-log resource tag. If omitted, the
   * export still runs but no audit event is logged. Per 2026-05-06
   * audit Lens 8: every coordinator-side export should be attributable.
   */
  auditResource?: string
}

export function exportToCsv(
  filename: string,
  columns: CsvColumn[],
  rows: Record<string, unknown>[],
  options: ExportToCsvOptions = {},
): void {
  const csv = buildCsv(columns, rows)
  // BOM tells Excel to interpret the file as UTF-8.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  // Fire-and-forget audit beacon. We do NOT await \u2014 the download has
  // already triggered, and a slow logger must not block the UX. The
  // server endpoint itself is rate-limited and authenticates either
  // platform or couple session.
  if (options.auditResource && typeof window !== 'undefined') {
    void fetch('/api/audit/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        resource: options.auditResource,
        mode: 'export',
        rowCount: rows.length,
        filename,
        format: 'csv',
      }),
    }).catch(() => {
      // Logging failures are not user-visible.
    })
  }
}
