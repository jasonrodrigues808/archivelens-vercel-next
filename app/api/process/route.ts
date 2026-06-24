import { NextResponse } from "next/server";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { parseCsvText } from "@/lib/csv";
import { aiReuseKey, expandGroupedResults, prepareExtractionGroups } from "@/lib/dedupe";
import { analyzeArticle } from "@/lib/ai";
import { processSingleUrl, tunePerformanceOptions } from "@/lib/scraper";
import type {
  AiResult,
  DomainHealth,
  ProcessOptions,
  ProcessResponse,
  RowRecord,
  ScrapeResult,
} from "@/types/archivelens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PayloadSchema = z.object({
  csvText: z.string().optional(),
  rows: z.array(z.record(z.unknown())).optional(),
  options: z.object({
    urlColumn: z.string().min(1),
    titleColumn: z.string().optional(),
    summaryColumn: z.string().optional(),
    duplicateGroupColumn: z.string().optional(),
    recoveryRoute: z
      .enum(["balanced", "fast", "live-first", "archive-first", "live-only", "archive-only"])
      .default("balanced"),
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
    openaiBaseUrl: z.string().optional(),
  }),
}).superRefine((payload, ctx) => {
  const hasCsvText = Boolean(payload.csvText?.trim());
  const hasRows = Boolean(payload.rows?.length);

  if (!hasCsvText && !hasRows) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either csvText or rows. Large browser runs should send rows in chunks.",
    });
  }
});

const MAX_VERCEL_SAFE_RESPONSE_BYTES = 3_800_000;
const RESPONSE_TEXT_BUDGET_BYTES = 2_300_000;
const RESPONSE_TRACE_BUDGET_BYTES = 450_000;
const RESPONSE_EVIDENCE_BUDGET_BYTES = 300_000;

async function readJsonPayload(request: Request): Promise<unknown> {
  const encoding = String(request.headers.get("content-encoding") || "").toLowerCase();
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected application/json, received '${contentType || "unknown"}'.`);
  }

  const rawBuffer = Buffer.from(await request.arrayBuffer());

  if (!rawBuffer.length) {
    throw new Error("Request body was empty.");
  }

  let text: string;

  if (encoding.includes("gzip")) {
    try {
      text = gunzipSync(rawBuffer).toString("utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not decompress gzipped request body: ${message}`);
    }
  } else if (!encoding || encoding === "identity") {
    text = rawBuffer.toString("utf8");
  } else {
    throw new Error(`Unsupported content-encoding '${encoding}'.`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Request body was not valid JSON: ${message}`);
  }
}

function clipString(value: unknown, maxChars: number): { value: string; clipped: boolean } {
  const text = String(value ?? "");

  if (text.length <= maxChars) {
    return { value: text, clipped: false };
  }

  const suffix = `\n\n[ARCHIVELENS: truncated in browser response to stay under Vercel payload limits; original length ${text.length.toLocaleString()} chars]`;

  return {
    value: `${text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`,
    clipped: true,
  };
}

function responseBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function compactRowsForVercelResponse(rows: any[], logs: string[]): any[] {
  if (!rows.length) {
    return rows;
  }

  const textLimit = Math.max(
    900,
    Math.min(24_000, Math.floor(RESPONSE_TEXT_BUDGET_BYTES / rows.length)),
  );
  const traceLimit = Math.max(
    450,
    Math.min(8_000, Math.floor(RESPONSE_TRACE_BUDGET_BYTES / rows.length)),
  );
  const evidenceLimit = Math.max(
    350,
    Math.min(6_000, Math.floor(RESPONSE_EVIDENCE_BUDGET_BYTES / rows.length)),
  );

  let clippedText = 0;
  let clippedTrace = 0;
  let clippedEvidence = 0;

  const compacted = rows.map((row) => {
    const next = { ...row };

    const fetched = clipString(next.fetched_text, textLimit);
    const trace = clipString(next.extraction_trace_json, traceLimit);
    const evidence = clipString(next.evidence_json, evidenceLimit);

    next.fetched_text = fetched.value;
    next.extraction_trace_json = trace.value;
    next.evidence_json = evidence.value;

    if (fetched.clipped) clippedText += 1;
    if (trace.clipped) clippedTrace += 1;
    if (evidence.clipped) clippedEvidence += 1;

    if (fetched.clipped || trace.clipped || evidence.clipped) {
      next._archivelens_response_compacted = true;
      next._archivelens_response_text_limit = textLimit;
      next._archivelens_response_trace_limit = traceLimit;
      next._archivelens_response_evidence_limit = evidenceLimit;
    }

    return next;
  });

  if (clippedText || clippedTrace || clippedEvidence) {
    logs.push(
      `Vercel-safe response compaction applied: fetched_text clipped on ${clippedText} rows, extraction trace clipped on ${clippedTrace} rows, evidence clipped on ${clippedEvidence} rows. ` +
        "This keeps the browser response below Vercel payload limits. For complete full-text storage on very large runs, connect Vercel Blob/Supabase or process smaller batches.",
    );
  }

  return compacted;
}

function makeSafeProcessResponse(response: ProcessResponse, logs: string[]): ProcessResponse {
  let safeResponse = response;
  let bytes = responseBytes(safeResponse);

  if (bytes <= MAX_VERCEL_SAFE_RESPONSE_BYTES) {
    return safeResponse;
  }

  const compactedRows = compactRowsForVercelResponse(response.rows as any[], logs);
  safeResponse = { ...response, rows: compactedRows, logs };
  bytes = responseBytes(safeResponse);

  if (bytes > MAX_VERCEL_SAFE_RESPONSE_BYTES) {
    const smallerLogs = logs.slice(-120);
    smallerLogs.push(
      `Response was still large after compaction (${bytes.toLocaleString()} bytes). Logs were shortened to keep the response deploy-safe.`,
    );
    safeResponse = { ...safeResponse, logs: smallerLogs };
  }

  return safeResponse;
}

function allColumns(rows: Array<Record<string, unknown>>): string[] {
  const ordered = new Set<string>();
  rows.forEach((row) => Object.keys(row).forEach((key) => ordered.add(key)));
  return Array.from(ordered);
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function domainFromRow(row: RowRecord, urlColumn: string): string {
  const raw = String(
    row.source_url_used || row.canonical_url || row[urlColumn] || row.url || row.link || "",
  );

  try {
    return new URL(raw).hostname.replace(/^www\./, "") || "unknown";
  } catch {
    return "unknown";
  }
}

function average(values: number[]): number {
  const clean = values.filter((value) => Number.isFinite(value));

  if (!clean.length) {
    return 0;
  }

  return Math.round((clean.reduce((sum, value) => sum + value, 0) / clean.length) * 10) / 10;
}

function domainHealth(
  rows: Array<ScrapeResult & Partial<AiResult>>,
  urlColumn: string,
): DomainHealth[] {
  const groups = new Map<string, Array<ScrapeResult & Partial<AiResult>>>();

  rows.forEach((row) => {
    const domain = domainFromRow(row, urlColumn);
    const bucket = groups.get(domain) ?? [];
    bucket.push(row);
    groups.set(domain, bucket);
  });

  return Array.from(groups.entries())
    .map(([domain, bucket]) => {
      const labels = bucket.map((row) => String(row.quality_label ?? ""));

      return {
        domain,
        rows: bucket.length,
        fullText: labels.filter((label) => label === "full_text").length,
        partial: labels.filter((label) => ["partial_text", "low_confidence"].includes(label))
          .length,
        failed: labels.filter((label) => ["failed", "url_only"].includes(label)).length,
        botBlocked: labels.filter((label) => label === "bot_blocked").length,
        authRequired: labels.filter((label) => label === "auth_required").length,
        rateLimited: labels.filter((label) => label === "rate_limited").length,
        robotsDisallowed: labels.filter((label) => label === "robots_disallowed").length,
        averageExtractionScore: average(bucket.map((row) => numeric(row.extraction_score))),
        averageQualityScore: average(bucket.map((row) => numeric(row.quality_score))),
        averageAlignmentScore: average(bucket.map((row) => numeric(row.summary_alignment_score))),
      };
    })
    .sort((a, b) => b.rows - a.rows || b.fullText - a.fullText || a.domain.localeCompare(b.domain));
}

function summarize(
  rows: ScrapeResult[],
  started: number,
  representativeJobs: number,
  aiCalls: number,
  aiCallsSaved: number,
): ProcessResponse["stats"] {
  return {
    inputRows: rows.length,
    representativeJobs,
    duplicateRequestsSaved: Math.max(0, rows.length - representativeJobs),
    fullTextRows: rows.filter((row) => row.quality_label === "full_text").length,
    partialRows: rows.filter((row) => ["partial_text", "low_confidence"].includes(row.quality_label))
      .length,
    failedRows: rows.filter((row) =>
      ["failed", "url_only", "robots_disallowed", "rate_limited"].includes(row.quality_label),
    ).length,
    botBlockedRows: rows.filter((row) => row.quality_label === "bot_blocked").length,
    authRequiredRows: rows.filter((row) => row.quality_label === "auth_required").length,
    aiCalls,
    aiCallsSaved,
    elapsedMs: Date.now() - started,
  };
}

function settingsSnapshot(options: ProcessOptions): Partial<ProcessOptions> {
  return {
    urlColumn: options.urlColumn,
    titleColumn: options.titleColumn,
    summaryColumn: options.summaryColumn,
    duplicateGroupColumn: options.duplicateGroupColumn,
    recoveryRoute: options.recoveryRoute,
    performanceProfile: options.performanceProfile,
    concurrency: options.concurrency,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    minChars: options.minChars,
    respectRobots: options.respectRobots,
    useJina: options.useJina,
    useWayback: options.useWayback,
    enableAI: options.enableAI,
    reuseDuplicateAI: options.reuseDuplicateAI,
    aiProvider: options.aiProvider,
    aiModel: options.aiModel,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency || 1, 12));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(safeConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

export async function POST(request: Request): Promise<NextResponse> {
  const started = Date.now();
  const runId = `run_${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();

  try {
    const parsedPayload = PayloadSchema.parse(await readJsonPayload(request));

    const rows = parsedPayload.rows?.length
      ? (parsedPayload.rows as RowRecord[])
      : parseCsvText(parsedPayload.csvText ?? "");

    const options: ProcessOptions = tunePerformanceOptions(
      parsedPayload.options as ProcessOptions,
    );

    if (!rows.length) {
      throw new Error("CSV contained no data rows.");
    }

    if (!rows[0] || !(options.urlColumn in rows[0])) {
      throw new Error(`URL column '${options.urlColumn}' was not found in the CSV.`);
    }

    const logs: string[] = [`${runId} started with ${rows.length} input rows.`];

    const { jobs, groups, originalRows } = prepareExtractionGroups(
      rows,
      options.urlColumn,
      options.duplicateGroupColumn || "None",
    );

    const representativeIndexByGroup = new Map(
      jobs.map((job) => [job.key, job.representativeIndex]),
    );

    const groupResults = new Map<string, ScrapeResult>();

    let completed = 0;

    await mapWithConcurrency(
      jobs,
      Math.max(1, Math.min(options.concurrency, 12)),
      async (job) => {
        const result = await processSingleUrl(
          String(job.row[options.urlColumn] ?? ""),
          job.row,
          options,
        );

        groupResults.set(job.key, result);
        completed += 1;

        const title = String(
          result.extracted_headline || result[options.urlColumn] || "Document",
        ).slice(0, 90);

        logs.push(
          `${String(completed).padStart(4, " ")}/${jobs.length} rows=${
            groups.get(job.key)?.length ?? 1
          } ${result.quality_label} ${result.recovery_route} score=${
            result.extraction_score
          } candidates=${result.candidate_count} ${title}`,
        );
      },
    );

    let expandedRows: any[] = expandGroupedResults(
      originalRows,
      groups,
      groupResults,
      representativeIndexByGroup,
      options.urlColumn,
    );

    let aiCalls = 0;
    let aiCallsSaved = 0;

    if (options.enableAI) {
      const aiGroups = new Map<string, number[]>();

      expandedRows.forEach((row, index) => {
        const key = options.reuseDuplicateAI
          ? aiReuseKey(row, options.summaryColumn, index)
          : `__unique_ai__${index}`;

        const existing = aiGroups.get(key) ?? [];
        existing.push(index);
        aiGroups.set(key, existing);
      });

      const aiJobs = Array.from(aiGroups.entries()).map(([key, indices]) => ({
        key,
        index: indices[0],
        row: expandedRows[indices[0]],
      }));

      const aiResults = new Map<string, AiResult>();
      aiCalls = aiJobs.length;
      aiCallsSaved = Math.max(0, expandedRows.length - aiJobs.length);

      let aiCompleted = 0;

      await mapWithConcurrency(
        aiJobs,
        Math.max(1, Math.min(4, options.concurrency)),
        async (job) => {
          const result = await analyzeArticle(job.row, options);
          aiResults.set(job.key, result);
          aiCompleted += 1;

          logs.push(
            `AI ${String(aiCompleted).padStart(4, " ")}/${aiJobs.length} rows=${
              aiGroups.get(job.key)?.length ?? 1
            } score=${result.quality_score} align=${
              result.summary_alignment_score
            } complete=${result.extraction_completeness_score} ${result.status} ${result.headline.slice(
              0,
              90,
            )}`,
          );
        },
      );

      expandedRows = expandedRows.map((row, index) => {
        const key = options.reuseDuplicateAI
          ? aiReuseKey(row, options.summaryColumn, index)
          : `__unique_ai__${index}`;

        const result = aiResults.get(key);

        if (!result) {
          return row;
        }

        const { evidence: _evidence, ...flatResult } = result;

        return {
          ...row,
          ...flatResult,
          key_entities: result.key_entities.join(", "),
          key_quotes: result.key_quotes.join(" | "),
          evidence_json: result.evidence_json,
          _archivelens_ai_reused_for_group: (aiGroups.get(key)?.length ?? 1) > 1,
          _archivelens_ai_group_size: aiGroups.get(key)?.length ?? 1,
        };
      });
    }

    const response: ProcessResponse = {
      runId,
      createdAt,
      rows: expandedRows,
      stats: summarize(expandedRows, started, jobs.length, aiCalls, aiCallsSaved),
      domainHealth: domainHealth(expandedRows, options.urlColumn),
      logs,
      columns: allColumns(expandedRows),
      settingsSnapshot: settingsSnapshot(options),
    };

    const safeResponse = makeSafeProcessResponse(response, logs);

    return NextResponse.json(safeResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        error: message,
        runId,
        createdAt,
      },
      { status: 400 },
    );
  }
}