import Papa from "papaparse";
import type { RowRecord } from "@/types/archivelens";

export function parseCsvText(csvText: string): RowRecord[] {
  const parsed = Papa.parse<RowRecord>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => String(header || "").trim(),
    transform: (value) => String(value ?? "").trim()
  });

  if (parsed.errors.length) {
    const first = parsed.errors[0];
    throw new Error(`CSV parse error on row ${first.row ?? "?"}: ${first.message}`);
  }

  return parsed.data.filter((row) => Object.values(row).some((value) => String(value ?? "").trim()));
}

export function unparseCsv(rows: RowRecord[]): string {
  return Papa.unparse(rows, { quotes: false, newline: "\n" });
}

export function detectUrlColumn(columns: string[]): string {
  const exact = ["url", "article_url", "link", "source_url", "web_url", "website"];
  for (const wanted of exact) {
    const found = columns.find((col) => col.trim().toLowerCase() === wanted);
    if (found) return found;
  }
  return columns.find((col) => /(url|link|source|website|href)/i.test(col)) ?? columns[0] ?? "";
}

export function detectTitleColumn(columns: string[]): string {
  const exact = ["title", "headline", "article_title", "article headline", "name", "hed"];
  for (const wanted of exact) {
    const found = columns.find((col) => col.trim().toLowerCase() === wanted);
    if (found) return found;
  }
  return columns.find((col) => /(title|headline|article name|\bhed\b)/i.test(col)) ?? "None";
}

export function detectSummaryColumn(columns: string[]): string {
  const exact = ["summary", "snippet", "abstract", "description", "teaser", "dek"];
  for (const wanted of exact) {
    const found = columns.find((col) => col.trim().toLowerCase() === wanted);
    if (found) return found;
  }
  return columns.find((col) => /(summary|snippet|abstract|description|teaser|dek)/i.test(col)) ?? "None";
}
