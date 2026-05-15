'use client'

/**
 * Shared CSV file-upload control for every import surface.
 *
 * One control, used by all the onboarding importers (CRM import,
 * web-form import, tour-scheduler import) so file upload behaves
 * identically everywhere: pick a file, read its text, hand it back
 * via onText. The caller decides what to do with the text.
 *
 * Accepts .csv / .tsv / .txt — the shared parseCsvRows auto-detects
 * comma vs tab, so a file exported either way (or pasted out of a
 * spreadsheet) parses correctly.
 */

import { Upload } from 'lucide-react'

interface CsvFileInputProps {
  /** Called with the file's full text once read. */
  onText: (text: string, fileName: string) => void
  /** Called with a human message if the file could not be read. */
  onError?: (message: string) => void
  /** Button label. Defaults to "Choose CSV file". */
  label?: string
}

export function CsvFileInput({ onText, onError, label }: CsvFileInputProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-sage-300 bg-white px-3 py-2 text-xs font-medium text-sage-700 hover:bg-sage-50">
      <Upload className="h-3.5 w-3.5" />
      {label ?? 'Choose CSV file'}
      <input
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            const text = await file.text()
            onText(text, file.name)
          } catch {
            onError?.('Could not read that file. Try a .csv export.')
          }
          // Reset so the same file can be re-selected after a failed run.
          e.target.value = ''
        }}
      />
    </label>
  )
}
