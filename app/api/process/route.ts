import { NextResponse } from "next/server";
import pLimit from "p-limit";
import { z } from "zod";
import { parseCsvText } from "@/lib/csv";
import { aiReuseKey, expandGroupedResults, prepareExtractionGroups } from "@/lib/dedupe";
import { analyzeArticle } from "@/lib/ai";
import { processSingleUrl, tunePerformanceOptions } from "@/lib/scraper";
import type { AiResult, ProcessOptions, ProcessResponse, ScrapeResult } from "@/types/archivelens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PayloadSchema = z.object({
  csvText: z.string().min(1, "CSV text is required."),
  options: z.object({
    urlColumn: z.string().min(1),
    titleColumn: z.string().optional(),
    summaryColumn: z.string().optional(),
    duplicateGroupColumn: z.string().optional(),
    recoveryRoute: z.enum(["balanced", "fast", "live-first", "archive-first", "live-only", "archive-only"]).default("balanced"),
    performanceProfile: z.enum(["balanced", "fast", "maximum"]).default("balanced"),
    concurrency: z.coerce.number().int().min(1).max(12).default(4),
    retries: z.coerce.number().int().min(1).max(8).default(3),
    timeoutMs: z.coerce.number().int().min(3_000).max(60_000).default(15_000),
    minChars: z.coerce.number().int().min(120).max(5_000).default(300),
    respectRobots: z.boolean().default(true),
    useJina: z.boolean().default(true),
    useWayback: z.boolean().default(true),
    authorizedCookie: z.string().optional(),
    enableAI: z.boolean().default(false),
    reuseDuplicateAI: z.boolean().default(true),
    aiProvider: z.enum(["huit", "openai", "gemini"]).default("huit"),
    aiModel: z.string().default("gpt-4o-mini"),
    customRubric: z.string().optional(),
    apiCredentialMode: z.enum(["environment", "manual"]).default("environment"),
    aiApiKey: z.string().optional(),
    aiBaseUrl: z.string().optional(),
    huitApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    geminiApiKey: z.string().optional(),
    huitBaseUrl: z.string().optional(),
    openaiBaseUrl: z.string().optional()
  })
});

function allColumns(rows: Array<Record<string, unknown>>): string[] {
  const ordered = new Set<string>();
  rows.forEach((row) => Object.keys(row).forEach((key) => ordered.add(key)));
  return Array.from(ordered);
}

function summarize(rows: ScrapeResult[], started: number, representativeJobs: number, aiCalls: number, aiCallsSaved: number): ProcessResponse["stats"] {
  return {
    inputRows: rows.length,
    representativeJobs,
    duplicateRequestsSaved: Math.max(0, rows.length - representativeJobs),
    fullTextRows: rows.filter((row) => row.quality_label === "full_text").length,
    partialRows: rows.filter((row) => ["partial_text", "low_confidence"].includes(row.quality_label)).length,
    failedRows: rows.filter((row) => ["failed", "url_only", "robots_disallowed", "rate_limited"].includes(row.quality_label)).length,
    botBlockedRows: rows.filter((row) => row.quality_label === "bot_blocked").length,
    authRequiredRows: rows.filter((row) => row.quality_label === "auth_required").length,
    aiCalls,
    aiCallsSaved,
    elapsedMs: Date.now() - started
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const started = Date.now();

  try {
    const parsedPayload = PayloadSchema.parse(await request.json());
    const rows = parseCsvText(parsedPayload.csvText);
    const options: ProcessOptions = tunePerformanceOptions(parsedPayload.options as ProcessOptions);

    if (!rows.length) throw new Error("CSV contained no data rows.");
    if (!rows[0] || !(options.urlColumn in rows[0])) throw new Error(`URL column '${options.urlColumn}' was not found in the CSV.`);

    const logs: string[] = [];
    const { jobs, groups, originalRows } = prepareExtractionGroups(rows, options.urlColumn, options.duplicateGroupColumn || "None");
    const representativeIndexByGroup = new Map(jobs.map((job) => [job.key, job.representativeIndex]));
    const scrapeLimit = pLimit(Math.max(1, Math.min(options.concurrency, 12)));
    const groupResults = new Map<string, ScrapeResult>();

    let completed = 0;
    await Promise.all(
      jobs.map((job) =>
        scrapeLimit(async () => {
          const result = await processSingleUrl(String(job.row[options.urlColumn] ?? ""), job.row, options);
          groupResults.set(job.key, result);
          completed += 1;
          const title = String(result.extracted_headline || result[options.urlColumn] || "Document").slice(0, 90);
          logs.push(`${String(completed).padStart(4, " ")}/${jobs.length} rows=${groups.get(job.key)?.length ?? 1} ${result.quality_label} ${result.recovery_route} ${title}`);
        })
      )
    );

    let expandedRows = expandGroupedResults(originalRows, groups, groupResults, representativeIndexByGroup, options.urlColumn);

    let aiCalls = 0;
    let aiCallsSaved = 0;

    if (options.enableAI) {
      const aiGroups = new Map<string, number[]>();
      expandedRows.forEach((row, index) => {
        const key = options.reuseDuplicateAI ? aiReuseKey(row, options.summaryColumn, index) : `__unique_ai__${index}`;
        const existing = aiGroups.get(key) ?? [];
        existing.push(index);
        aiGroups.set(key, existing);
      });

      const aiJobs = Array.from(aiGroups.entries()).map(([key, indices]) => ({ key, index: indices[0], row: expandedRows[indices[0]] }));
      const aiLimit = pLimit(Math.max(1, Math.min(4, options.concurrency)));
      const aiResults = new Map<string, AiResult>();
      aiCalls = aiJobs.length;
      aiCallsSaved = Math.max(0, expandedRows.length - aiJobs.length);

      let aiCompleted = 0;
      await Promise.all(
        aiJobs.map((job) =>
          aiLimit(async () => {
            const result = await analyzeArticle(job.row, options);
            aiResults.set(job.key, result);
            aiCompleted += 1;
            logs.push(`AI ${String(aiCompleted).padStart(4, " ")}/${aiJobs.length} rows=${aiGroups.get(job.key)?.length ?? 1} score=${result.quality_score} align=${result.summary_alignment_score} ${result.status} ${result.headline.slice(0, 90)}`);
          })
        )
      );

      expandedRows = expandedRows.map((row, index) => {
        const key = options.reuseDuplicateAI ? aiReuseKey(row, options.summaryColumn, index) : `__unique_ai__${index}`;
        const result = aiResults.get(key);
        if (!result) return row;
        return {
          ...row,
          ...result,
          key_entities: result.key_entities.join(", "),
          key_quotes: result.key_quotes.join(" | "),
          _archivelens_ai_reused_for_group: (aiGroups.get(key)?.length ?? 1) > 1,
          _archivelens_ai_group_size: aiGroups.get(key)?.length ?? 1
        };
      });
    }

    const response: ProcessResponse = {
      rows: expandedRows,
      stats: summarize(expandedRows, started, jobs.length, aiCalls, aiCallsSaved),
      logs,
      columns: allColumns(expandedRows)
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
