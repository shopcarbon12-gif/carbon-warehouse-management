"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2 } from "lucide-react";
import {
  CUSTOMER_PREVIEW_COLUMNS,
  parseCsv,
  rowsFromMatrix,
  type ParsedRow,
} from "@/lib/csv-customer-parse";
import { commitImport } from "./actions";
import type { ImportSummary } from "@/lib/csv-customer-import";

export type LocationOption = { id: number; label: string };

const PREVIEW_LIMIT = 100;
const BATCH_SIZE = 500; // rows per commit request / transaction
const MAX_ISSUES = 200;

const EMPTY_SUMMARY: ImportSummary = {
  total: 0,
  matched: 0,
  created: 0,
  skipped: 0,
  errors: 0,
  outcomes: [],
};

export default function ImportClient({ locations }: { locations: LocationOption[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setError(null);
    setSummary(null);
    setProgress(null);
    setRows([]);
    setFileName(file.name);
    try {
      const name = file.name.toLowerCase();
      let parsed: { rows: ParsedRow[]; errors: string[] };
      if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        parsed = await parseXlsx(await file.arrayBuffer());
      } else if (name.endsWith(".xls")) {
        setError("Old .xls files aren't supported — re-save as .xlsx or .csv.");
        return;
      } else {
        parsed = parseCsv(await file.text());
      }
      if (parsed.errors.length) setError(parsed.errors.join(" "));
      setRows(parsed.rows);
      if (parsed.rows.length === 0 && !parsed.errors.length) {
        setError("No customer rows found in the file.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the file.");
    } finally {
      setParsing(false);
    }
  }

  async function onImport() {
    setImporting(true);
    setError(null);
    setSummary(null);
    const acc: ImportSummary = { ...EMPTY_SUMMARY, outcomes: [] };
    const locId = locationId ? Number(locationId) : null;
    try {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const res = await commitImport(batch, locId);
        if (!res.ok || !res.summary) {
          setError(`${res.error || "Import failed."} (after ${acc.total} rows)`);
          break;
        }
        const s = res.summary;
        acc.total += s.total;
        acc.matched += s.matched;
        acc.created += s.created;
        acc.skipped += s.skipped;
        acc.errors += s.errors;
        for (const o of s.outcomes) {
          if ((o.status === "error" || o.status === "skipped") && acc.outcomes.length < MAX_ISSUES) {
            acc.outcomes.push(o);
          }
        }
        setProgress({ done: Math.min(i + BATCH_SIZE, rows.length), total: rows.length });
        setSummary({ ...acc });
      }
      // Success path: clear the staged file so a re-click can't double-import.
      if (acc.total >= rows.length) {
        setRows([]);
        setFileName(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const hasRows = rows.length > 0;
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-300 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>
      )}

      {summary && <ResultBlock summary={summary} done={!importing} />}

      {/* Upload + location */}
      <div className="border border-border bg-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">File</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xlsm,.xls,text/csv"
              onChange={onFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing || importing}
              className="inline-flex items-center gap-2 px-4 py-2 border border-border bg-card text-sm font-bold hover:bg-muted disabled:opacity-50"
            >
              {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload CSV / XLSX file
            </button>
          </div>

          <label className="flex flex-col gap-1 sm:min-w-64">
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              Where are these customers being added from?
            </span>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="border border-border bg-card px-3 py-2 text-sm"
            >
              <option value="">Not at a store (vendor list / signup sheet)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>
        </div>
        {fileName && (
          <p className="text-xs text-muted-foreground">
            {fileName}
            {hasRows ? ` — ${rows.length.toLocaleString()} customer${rows.length === 1 ? "" : "s"}` : ""}
          </p>
        )}
      </div>

      {/* Preview file */}
      <div className="border border-border bg-card p-5">
        <h2 className="text-base font-bold mb-3">Preview file:</h2>
        <div className="overflow-x-auto border border-border">
          {hasRows ? (
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="bg-muted uppercase tracking-wider font-bold">
                <tr>
                  {CUSTOMER_PREVIEW_COLUMNS.map((c) => (
                    <th key={c.header} className="text-left px-3 py-2 border-b border-border">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.slice(0, PREVIEW_LIMIT).map((r) => (
                  <tr key={r.rowIndex}>
                    {CUSTOMER_PREVIEW_COLUMNS.map((c) => {
                      const v = r[c.field];
                      return (
                        <td key={c.header} className="px-3 py-2">
                          {v ? String(v) : <span className="text-muted-foreground">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No file uploaded yet. Uploaded rows will appear here, mapped to the columns above.
            </div>
          )}
        </div>
        {rows.length > PREVIEW_LIMIT && (
          <p className="text-xs text-muted-foreground mt-2">
            Showing first {PREVIEW_LIMIT} of {rows.length.toLocaleString()} rows. All{" "}
            {rows.length.toLocaleString()} will be imported.
          </p>
        )}
      </div>

      {/* Progress */}
      {importing && progress && (
        <div className="border border-border bg-card p-4">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Importing…</span>
            <span>{progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)</span>
          </div>
          <div className="h-2 bg-muted overflow-hidden rounded">
            <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Preview -> Import customers */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onImport}
          disabled={!hasRows || importing || parsing}
          className="inline-flex items-center gap-2 px-4 py-2 border border-border bg-foreground text-background text-sm font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          {hasRows
            ? `Import ${rows.length.toLocaleString()} customer${rows.length === 1 ? "" : "s"}`
            : "Preview"}
        </button>
      </div>
    </div>
  );
}

/** Read an .xlsx ArrayBuffer in the browser via a code-split exceljs import. */
async function parseXlsx(
  data: ArrayBuffer,
): Promise<{ rows: ParsedRow[]; errors: string[] }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as never);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], errors: ["The workbook has no sheets."] };

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (rowObj) => {
    const values = rowObj.values as unknown[]; // 1-based; [0] is undefined
    const arr: string[] = [];
    for (let i = 1; i < values.length; i++) arr[i - 1] = cellToString(values[i]);
    matrix.push(arr);
  });
  const { rows, errors } = rowsFromMatrix(matrix);
  return { rows, errors };
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.result != null) return String(o.result);
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(v);
}

function ResultBlock({ summary, done }: { summary: ImportSummary; done: boolean }) {
  const issues = summary.outcomes.filter((o) => o.status === "error" || o.status === "skipped");
  return (
    <div className="border border-border border-l-4 border-l-emerald-500 bg-card p-5">
      <h2 className="text-base font-bold mb-2">{done ? "Import complete" : "Importing…"}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
        <Stat label="Rows" value={summary.total} />
        <Stat label="Matched" value={summary.matched} />
        <Stat label="Created" value={summary.created} />
        <Stat label="Skipped" value={summary.skipped} />
        <Stat label="Errors" value={summary.errors} bad={summary.errors > 0} />
      </div>
      {issues.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-bold">Issues ({issues.length})</summary>
          <ul className="text-xs mt-2 space-y-1">
            {issues.slice(0, 50).map((o) => (
              <li key={`${o.rowIndex}-${o.status}`}>
                <b>row {o.rowIndex}</b> · {o.identity ?? "—"} · {o.status}
                {o.message ? ` · ${o.message}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="border border-border p-3">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold tabular-nums mt-1 ${bad ? "text-rose-700" : ""}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
