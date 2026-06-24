import type { RowRecord, ScrapeResult } from "@/types/archivelens";

export type ExtractionJob = {
  key: string;
  representativeIndex: number;
  row: RowRecord;
};

export type PreparedGroups = {
  jobs: ExtractionJob[];
  groups: Map<string, number[]>;
  originalRows: RowRecord[];
};

export function normalizeDuplicateKey(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text || ["nan", "none", "null", "undefined"].includes(text.toLowerCase())) return "";

  text = text.normalize("NFKC");
  text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
  text = text.toLowerCase().replace(/\s+/g, " ").trim();

  // Remove common outlet suffixes and live/update decorations.
  text = text.replace(/\s*[|]\s*[^|]{2,80}$/g, "");
  text = text.replace(/\s+[-–—]\s+(breaking|live updates?|updated|analysis|opinion)\b.*$/g, "");
  text = text.replace(/\b(updated|breaking)[:\s-]+/g, "");

  text = text.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return text;
}

export function representativeUrlScore(row: RowRecord, urlColumn: string): number {
  const url = String(row[urlColumn] ?? "").trim();
  const lower = url.toLowerCase();
  let score = 0;

  if (lower.startsWith("https://")) score += 30;
  else if (lower.startsWith("http://")) score += 18;

  if (!lower.includes("?")) score += 10;
  if (/(utm_|fbclid=|gclid=|mc_cid=|mc_eid=)/i.test(lower)) score -= 14;
  if (/(\/login|\/signin|\/subscribe|facebook\.com|twitter\.com|x\.com\/|instagram\.com)/i.test(lower)) score -= 40;
  if (/(\/amp\b|amp\.)/i.test(lower)) score -= 4;

  score += Math.max(0, 18 - url.length / 18);
  return score;
}

export function duplicateGroupStats(rows: RowRecord[], groupColumn: string): {
  rows: number;
  groups: number;
  requestsSaved: number;
  largestGroup: number;
} {
  if (!rows.length || !groupColumn || groupColumn === "None") {
    return { rows: rows.length, groups: rows.length, requestsSaved: 0, largestGroup: rows.length ? 1 : 0 };
  }

  const groups = new Map<string, number>();
  rows.forEach((row, index) => {
    let key = normalizeDuplicateKey(row[groupColumn]);
    if (key.length < 8) key = `__unique__${index}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  });

  const groupCount = groups.size;
  const largest = Math.max(0, ...Array.from(groups.values()));
  return {
    rows: rows.length,
    groups: groupCount,
    requestsSaved: Math.max(0, rows.length - groupCount),
    largestGroup: largest
  };
}

export function prepareExtractionGroups(
  rows: RowRecord[],
  urlColumn: string,
  duplicateGroupColumn: string
): PreparedGroups {
  const originalRows = rows.map((row) => ({ ...row }));
  const useGrouping = Boolean(duplicateGroupColumn && duplicateGroupColumn !== "None");
  const groups = new Map<string, number[]>();

  originalRows.forEach((row, index) => {
    let key = useGrouping ? normalizeDuplicateKey(row[duplicateGroupColumn]) : "";
    if (key.length < 8) key = `__unique__${index}`;
    const existing = groups.get(key) ?? [];
    existing.push(index);
    groups.set(key, existing);
  });

  const jobs: ExtractionJob[] = [];

  for (const [key, indices] of groups.entries()) {
    const representativeIndex = indices.reduce((best, candidate) => {
      const bestScore = representativeUrlScore(originalRows[best], urlColumn);
      const candidateScore = representativeUrlScore(originalRows[candidate], urlColumn);
      return candidateScore > bestScore ? candidate : best;
    }, indices[0]);

    const row = {
      ...originalRows[representativeIndex],
      _archivelens_original_row_id: representativeIndex,
      _archivelens_dedupe_key: key,
      _archivelens_dedupe_group_size: indices.length,
      _archivelens_dedupe_representative: true
    };

    jobs.push({ key, representativeIndex, row });
  }

  return { jobs, groups, originalRows };
}

export function expandGroupedResults(
  originalRows: RowRecord[],
  groups: Map<string, number[]>,
  groupResults: Map<string, ScrapeResult>,
  representativeIndexByGroup: Map<string, number>,
  urlColumn: string
): ScrapeResult[] {
  const expanded = originalRows.map((row) => ({ ...row })) as ScrapeResult[];

  for (const [key, indices] of groups.entries()) {
    const representativeResult = groupResults.get(key);
    if (!representativeResult) continue;

    const repIndex = representativeIndexByGroup.get(key) ?? indices[0];
    const repUrl = String(originalRows[repIndex]?.[urlColumn] ?? "");
    const groupSize = indices.length;

    indices.forEach((index) => {
      expanded[index] = {
        ...expanded[index],
        ...representativeResult,
        ...originalRows[index],
        fetched_text: representativeResult.fetched_text,
        quality_label: representativeResult.quality_label,
        error_message: representativeResult.error_message,
        extracted_headline: representativeResult.extracted_headline,
        extracted_author: representativeResult.extracted_author,
        extracted_date: representativeResult.extracted_date,
        extracted_site_name: representativeResult.extracted_site_name,
        canonical_url: representativeResult.canonical_url,
        recovery_route: representativeResult.recovery_route,
        http_status: representativeResult.http_status,
        source_url_used: representativeResult.source_url_used,
        word_count: representativeResult.word_count,
        char_count: representativeResult.char_count,
        paragraph_count: representativeResult.paragraph_count,
        extraction_score: representativeResult.extraction_score,
        robots_note: representativeResult.robots_note,
        elapsed_s: representativeResult.elapsed_s,
        candidate_count: representativeResult.candidate_count,
        winning_candidate_route: representativeResult.winning_candidate_route,
        candidate_routes: representativeResult.candidate_routes,
        extraction_confidence_label: representativeResult.extraction_confidence_label,
        boilerplate_ratio: representativeResult.boilerplate_ratio,
        duplicate_paragraph_ratio: representativeResult.duplicate_paragraph_ratio,
        extraction_trace_json: representativeResult.extraction_trace_json,
        _archivelens_dedupe_key: key,
        _archivelens_dedupe_group_size: groupSize,
        _archivelens_dedupe_representative_row: repIndex,
        _archivelens_representative_url: repUrl,
        _archivelens_scraped_once_for_group: groupSize > 1
      };
    });
  }

  return expanded;
}

export function aiReuseKey(row: RowRecord, summaryColumn: string | undefined, fallbackIndex: number): string {
  let base = String(row._archivelens_dedupe_key ?? "").trim();
  if (!base) {
    base = normalizeDuplicateKey(row.extracted_headline ?? row.headline ?? row.title ?? "");
  }
  if (base.length < 8) base = `__unique_ai__${fallbackIndex}`;

  const summaryKey = summaryColumn && summaryColumn !== "None" ? normalizeDuplicateKey(row[summaryColumn]) : "";
  return `${base}::summary::${summaryKey}`;
}
