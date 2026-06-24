import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  AiResult,
  ProcessOptions,
  PromptGeneratorInput,
  PromptGeneratorResult,
  Provider,
  RowRecord,
} from "@/types/archivelens";

// ─── Constants ────────────────────────────────────────────────────────────────

const HUIT_DEFAULT_BASE_URL =
  "https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1";

// ─── Types ────────────────────────────────────────────────────────────────────

type EvidenceItem = {
  claim: string;
  quote: string;
  relevance: string;
};

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function safeString(value: unknown): string {
  return String(value ?? "").trim();
}

function clampScore(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!isFinite(num)) return fallback;
  return Math.min(100, Math.max(0, Math.round(num)));
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => safeString(item))
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[,|]\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function normalizeEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const claim = safeString(
        record.claim ?? record.point ?? record.label ?? record.finding,
      );
      const quote = safeString(
        record.quote ?? record.evidence ?? record.text ?? record.snippet,
      );
      const relevance = safeString(
        record.relevance ??
          record.reason ??
          record.note ??
          record.explanation,
      );
      if (!claim && !quote) return null;
      return { claim, quote, relevance };
    })
    .filter(Boolean)
    .slice(0, 8) as EvidenceItem[];
}

function providerLabel(provider: Provider): string {
  if (provider === "huit") return "OpenAI via HUIT";
  if (provider === "openai") return "OpenAI direct";
  if (provider === "gemini") return "Google Gemini";
  return provider;
}

// ─── Evidence Pack ────────────────────────────────────────────────────────────
// Intelligently trims long articles so they fit in the model context window.
// Takes: front 42%, sampled middle, back 30%

function evidencePack(text: string, maxChars = 22_000): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;

  const frontBudget  = Math.floor(maxChars * 0.42);
  const backBudget   = Math.floor(maxChars * 0.30);
  const middleBudget = maxChars - frontBudget - backBudget - 700;

  const front  = clean.slice(0, frontBudget);
  const back   = clean.slice(-backBudget);
  const middle = clean.slice(frontBudget, -backBudget);

  const sampleCount = 3;
  const sampleLen   = Math.max(400, Math.floor(middleBudget / sampleCount));
  const samples: string[] = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const start = Math.floor(
      Math.max(0, middle.length - sampleLen) *
        ((i + 1) / (sampleCount + 1)),
    );
    samples.push(middle.slice(start, start + sampleLen).trim());
  }

  return [
    "[BEGINNING OF ARTICLE]",
    front,
    "",
    "[REPRESENTATIVE MIDDLE SAMPLES]",
    samples.filter(Boolean).join("\n\n--- MIDDLE SAMPLE ---\n\n"),
    "",
    "[ENDING OF ARTICLE]",
    back,
    "",
    "[NOTE: Article exceeded the evidence pack limit and was trimmed.]",
  ].join("\n");
}

// ─── Fallback Result ──────────────────────────────────────────────────────────
// Returns a zeroed-out AiResult when AI cannot run.
// FIX: now accepts options so provider_used reflects reality.

function fallbackAi(
  metadata: RowRecord,
  status: string,
  note: string,
  options?: ProcessOptions,
): AiResult {
  const headline = safeString(
    metadata.extracted_headline ?? metadata.headline ?? metadata.title,
  );
  const author = safeString(metadata.extracted_author ?? metadata.author);

  return {
    quality_score:                  0,
    summary_alignment_score:        0,
    extraction_completeness_score:  0,
    article_relevance_score:        0,
    source_reliability_score:       0,
    national_outlet_confidence:     0,
    outlet_country_confidence:      0,
    status,
    ai_verification_status:         status,
    headline,
    author,
    is_national_outlet:             false,
    outlet_country:                 "Unknown",
    executive_summary:              "",
    deep_summary:                   "",
    reasoning:                      note,
    summary_alignment_notes:        note,
    key_entities:                   [],
    key_quotes:                     [],
    evidence:                       [],
    evidence_json:                  "[]",
    evidence_count:                 0,
    tone_and_bias:                  "",
    rubric_version:                 "archivelens-v3-fallback",
    model_used:                     options?.aiModel    ?? "",
    provider_used:                  options?.aiProvider ?? "huit", // ← FIXED
    analyzed_at:                    new Date().toISOString(),
  };
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(raw: string): Record<string, unknown> {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to regex extraction.
  }

  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI did not return a JSON object.");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

// ─── Normalize AI Response ────────────────────────────────────────────────────

function normalizeAiJson(
  parsed: Record<string, unknown>,
  metadata: RowRecord,
  options: ProcessOptions,
): AiResult {
  const status = safeString(
    parsed.ai_verification_status ??
      parsed.status ??
      parsed.verification_status ??
      "UNKNOWN",
  ).toUpperCase();

  const executiveSummary = safeString(
    parsed.executive_summary ?? parsed.deep_summary ?? parsed.summary,
  );

  const notes = safeString(
    parsed.summary_alignment_notes ??
      parsed.reasoning ??
      parsed.alignment_reasoning ??
      parsed.notes,
  );

  const evidence = normalizeEvidence(
    parsed.evidence ??
      parsed.supporting_evidence ??
      parsed.evidence_quotes,
  );

  const outletCountry =
    safeString(parsed.outlet_country ?? metadata.outlet_country) || "Unknown";

  const isNationalOutlet = Boolean(parsed.is_national_outlet);

  return {
    quality_score: clampScore(parsed.quality_score, 50),
    summary_alignment_score: clampScore(parsed.summary_alignment_score, 0),
    extraction_completeness_score: clampScore(
      parsed.extraction_completeness_score ?? parsed.completeness_score,
      0,
    ),
    article_relevance_score: clampScore(
      parsed.article_relevance_score ?? parsed.relevance_score,
      0,
    ),
    source_reliability_score: clampScore(
      parsed.source_reliability_score ?? parsed.source_score,
      0,
    ),
    national_outlet_confidence: clampScore(
      parsed.national_outlet_confidence,
      isNationalOutlet ? 75 : 0,
    ),
    outlet_country_confidence: clampScore(
      parsed.outlet_country_confidence,
      outletCountry !== "Unknown" ? 70 : 0,
    ),
    status,
    ai_verification_status: status,
    headline: safeString(
      parsed.headline ??
        metadata.extracted_headline ??
        metadata.headline ??
        metadata.title,
    ),
    author: safeString(
      parsed.author ?? metadata.extracted_author ?? metadata.author,
    ),
    is_national_outlet:      isNationalOutlet,
    outlet_country:          outletCountry,
    executive_summary:       executiveSummary,
    deep_summary:            executiveSummary,
    reasoning:               notes,
    summary_alignment_notes: notes,
    key_entities:            normalizeList(parsed.key_entities),
    key_quotes:              normalizeList(parsed.key_quotes),
    evidence,
    evidence_json:           JSON.stringify(evidence),
    evidence_count:          evidence.length,
    tone_and_bias:           safeString(parsed.tone_and_bias),
    rubric_version:          safeString(parsed.rubric_version ?? "archivelens-v3"),
    model_used:              safeString(options.aiModel),
    provider_used:           options.aiProvider,
    analyzed_at:             new Date().toISOString(),
  };
}

// ─── Credential Helpers ───────────────────────────────────────────────────────

function manualApiKeyFor(options: ProcessOptions): string {
  if (options.aiProvider === "gemini") {
    return safeString(options.geminiApiKey);
  }
  if (options.aiProvider === "huit") {
    return safeString(options.huitApiKey ?? options.openaiApiKey);
  }
  return safeString(options.openaiApiKey);
}

function environmentApiKeyFor(provider: Provider): string {
  if (provider === "gemini") return process.env.GEMINI_API_KEY ?? "";
  if (provider === "huit") {
    return (
      process.env.HUIT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? ""
    );
  }
  return process.env.OPENAI_API_KEY ?? "";
}

export function apiKeyFor(options: ProcessOptions): string {
  const manualKey = manualApiKeyFor(options);
  const mode =
    options.apiCredentialMode ?? (manualKey ? "manual" : "environment");
  if (mode === "manual") return manualKey;
  return environmentApiKeyFor(options.aiProvider);
}

function validBaseUrl(value: string, label: string): string {
  const trimmed = safeString(value);
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `${label} must start with http:// or https://. ` +
        `Paste API keys in the key field, not the base URL field.`,
    );
  }
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
}

export function baseUrlFor(options: ProcessOptions): string | undefined {
  if (options.aiProvider === "huit") {
    return (
      validBaseUrl(
        safeString(
          options.huitBaseUrl ??
            options.aiBaseUrl ??
            process.env.HUIT_OPENAI_BASE_URL,
        ),
        "HUIT/OpenAI base URL",
      ) || HUIT_DEFAULT_BASE_URL
    );
  }
  if (options.aiProvider === "openai") {
    return (
      validBaseUrl(
        safeString(options.openaiBaseUrl ?? options.aiBaseUrl),
        "OpenAI base URL",
      ) || undefined
    );
  }
  return undefined;
}

export function credentialSourceFor(
  options: ProcessOptions,
): "manual" | "environment" {
  const manualKey = manualApiKeyFor(options);
  const mode =
    options.apiCredentialMode ?? (manualKey ? "manual" : "environment");
  return mode === "manual" ? "manual" : "environment";
}

// ─── Client Factory ───────────────────────────────────────────────────────────

function openAiClient(options: ProcessOptions): OpenAI {
  const apiKey = apiKeyFor(options);
  if (!apiKey) {
    throw new Error(
      `Missing ${
        options.aiProvider === "huit" ? "HUIT/OpenAI" : "OpenAI"
      } API key.`,
    );
  }
  const defaultHeaders =
    options.aiProvider === "huit" && !apiKey.startsWith("sk-")
      ? { "api-key": apiKey, "x-api-key": apiKey }
      : undefined;

  return new OpenAI({
    apiKey,
    baseURL:        baseUrlFor(options),
    defaultHeaders,
  });
}

// ─── Retry Wrapper ────────────────────────────────────────────────────────────
// Auto-retries on rate limits / server errors with exponential backoff.

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 1_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const isRetryable =
        msg.includes("rate_limit") ||
        msg.includes("529") ||
        msg.includes("503") ||
        msg.includes("timeout");
      if (!isRetryable || attempt === retries) break;
      await new Promise((res) => setTimeout(res, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

// ─── AI Callers ───────────────────────────────────────────────────────────────

async function callOpenAi(
  prompt: string,
  systemPrompt: string,
  options: ProcessOptions,
  jsonMode: boolean,
): Promise<string> {
  const client = openAiClient(options);
  const model = options.aiModel || "gpt-4o-mini";
  const reasoningModel = /^(o1|o3|o4)/i.test(model);

  const response = await withRetry(() =>
    client.chat.completions.create({
      model,
      messages: reasoningModel
        ? [
            {
              role: "user",
              content: `${systemPrompt}\n\n---\n\n${prompt}`,
            },
          ]
        : [
            { role: "system", content: systemPrompt },
            { role: "user",   content: prompt },
          ],
      ...(reasoningModel
        ? {}
        : {
            temperature: jsonMode ? 0.1 : 0.35,
            ...(jsonMode
              ? { response_format: { type: "json_object" as const } }
              : {}),
          }),
    }),
  );

  return response.choices[0]?.message?.content ?? "";
}

async function callGemini(
  prompt: string,
  systemPrompt: string,
  options: ProcessOptions,
  jsonMode: boolean,
): Promise<string> {
  const apiKey = apiKeyFor(options);
  if (!apiKey) throw new Error("Missing Gemini API key.");

  const client = new GoogleGenerativeAI(apiKey);
  const model  = client.getGenerativeModel({
    model: options.aiModel || "gemini-1.5-flash",
  });

  const result = await withRetry(() =>
    model.generateContent({
      contents: [
        {
          role:  "user",
          parts: [{ text: `${systemPrompt}\n\n---\n\n${prompt}` }],
        },
      ],
      generationConfig: {
        temperature: jsonMode ? 0.1 : 0.35,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    }),
  );

  return result.response.text();
}

// ─── Test Connection ──────────────────────────────────────────────────────────

export async function testAiConnection(options: ProcessOptions): Promise<{
  ok:               boolean;
  message:          string;
  provider:         Provider;
  model:            string;
  credentialSource: "manual" | "environment";
}> {
  const provider = options.aiProvider;
  const model =
    options.aiModel ??
    (provider === "gemini" ? "gemini-1.5-flash" : "gpt-4o-mini");
  const credentialSource = credentialSourceFor(options);

  try {
    if (provider === "gemini") {
      const apiKey = apiKeyFor(options);
      if (!apiKey) {
        throw new Error(
          "Missing Gemini API key. Paste one in the API Console " +
            "or set GEMINI_API_KEY in Vercel.",
        );
      }
      const genModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
        model,
      });
      const result = await genModel.generateContent({
        contents: [
          {
            role:  "user",
            parts: [{ text: "Reply with exactly: ArchiveLens connected" }],
          },
        ],
        generationConfig: { temperature: 0 },
      });
      const text = result.response.text().trim();
      return {
        ok: true,
        message: `${providerLabel(provider)} connected with ${model}. Response: ${
          text || "OK"
        }`,
        provider,
        model,
        credentialSource,
      };
    }

    // OpenAI / HUIT
    const client       = openAiClient({ ...options, aiModel: model });
    const reasoningModel = /^(o1|o3|o4)/i.test(model);
    const response     = await client.chat.completions.create({
      model,
      messages: [
        {
          role:    "user",
          content: "Reply with exactly: ArchiveLens connected",
        },
      ],
      ...(reasoningModel ? {} : { temperature: 0 }),
    });
    const text = response.choices[0]?.message?.content?.trim() || "OK";
    return {
      ok: true,
      message: `${providerLabel(provider)} connected with ${model}. Response: ${text}`,
      provider,
      model,
      credentialSource,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, provider, model, credentialSource };
  }
}

// ─── Analyze Article ──────────────────────────────────────────────────────────

export async function analyzeArticle(
  row: RowRecord,
  options: ProcessOptions,
): Promise<AiResult> {
  const text = safeString(row.fetched_text);

  if (!options.enableAI) {
    return fallbackAi(
      row,
      "AI_DISABLED",
      "AI verification was not enabled for this run.",
      options, // ← FIXED: pass options
    );
  }

  if (!text || text.length < 50) {
    return fallbackAi(
      row,
      "REJECTED_EMPTY_TEXT",
      "Recovered text is empty or too short to analyze.",
      options, // ← FIXED: pass options
    );
  }

  const summaryColumn =
    options.summaryColumn && options.summaryColumn !== "None"
      ? options.summaryColumn
      : "";

  const providedSummary = summaryColumn
    ? safeString(row[summaryColumn])
    : "";

  const customRubric =
    safeString(options.customRubric) ||
    "Evaluate whether the recovered article is complete, relevant, " +
      "and aligned with the provided dataset summary.";

  const systemPrompt = [
    "You are ArchiveLens, an article verification and triage engine.",
    "Evaluate only the visible recovered text.",
    "Do not infer hidden or paywalled content.",
    "If the text is a paywall, login screen, bot-block page, privacy policy,",
    "homepage, archive shell, or unrelated page — flag it.",
    "Return ONLY valid JSON with these keys:",
    "quality_score, summary_alignment_score, extraction_completeness_score,",
    "article_relevance_score, source_reliability_score,",
    "national_outlet_confidence, outlet_country_confidence,",
    "summary_alignment_notes, ai_verification_status,",
    "headline, author, is_national_outlet, outlet_country,",
    "executive_summary, key_entities, key_quotes, evidence, tone_and_bias.",
    "Valid ai_verification_status values:",
    "VERIFIED_PASSED, PARTIAL_TRUNCATED, FAILED_SUMMARY_ALIGNMENT,",
    "FLAGGED_PAYWALL_OR_ERROR, LOW_RELEVANCE, NEEDS_MANUAL_REVIEW.",
    "All scores must be integers from 0 to 100.",
    "evidence must be an array of objects each with claim, quote, and relevance.",
    `Apply this user rubric strictly: ${customRubric}`,
  ].join("\n");

  const prompt = [
    `URL: ${safeString(row.source_url_used ?? row.url ?? row.link)}`,
    `Visible title metadata: ${safeString(
      row.extracted_headline ?? row.headline ?? row.title,
    )}`,
    `Visible author metadata: ${safeString(
      row.extracted_author ?? row.author,
    )}`,
    `Recovery label: ${safeString(row.quality_label)}`,
    `Provided original summary from dataset: ${
      providedSummary || "None provided"
    }`,
    "",
    "Recovered article evidence pack:",
    evidencePack(text),
  ].join("\n");

  try {
    const raw =
      options.aiProvider === "gemini"
        ? await callGemini(prompt, systemPrompt, options, true)
        : await callOpenAi(prompt, systemPrompt, options, true);

    return normalizeAiJson(extractJson(raw), row, options); // ← FIXED: pass options
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    return fallbackAi(row, "API_ERROR", note.slice(0, 500), options); // ← FIXED
  }
}

// ─── Prompt Generator (local template) ───────────────────────────────────────

function localPromptFromInput(
  input: PromptGeneratorInput,
  options?: ProcessOptions,
): string {
  const goal =
    safeString(input.userGoal) ||
    "Evaluate recovered articles for relevance, completeness, and summary alignment.";

  const audience  = safeString(input.audience)    || "a meticulous research assistant";
  const include   = safeString(input.mustInclude);
  const avoid     = safeString(input.mustAvoid);

  const strictnessRule =
    input.strictness === "strict"
      ? "Apply maximum precision. Flag anything ambiguous as NEEDS_MANUAL_REVIEW."
      : input.strictness === "lenient"
      ? "Allow reasonable inferences for partial or slightly ambiguous pages."
      : "Balance precision with practical judgment for mixed-quality media archives.";

  const mustIncludeBlock = include
    ? `\n\nMUST INCLUDE\n${include}`
    : "";
  const mustAvoidBlock = avoid
    ? `\n\nMUST AVOID\n${avoid}`
    : "";

  if (input.promptKind === "article-recovery") {
    return [
      `ROLE\nYou are ${audience}.`,
      `TASK\nRecover clean article prose for this goal:\n${goal}`,
      "EXTRACTION RULES",
      "1. Use only text visibly present in the recovered HTML or page text.",
      "2. Preserve headline, byline, publication date, headings, paragraph order, direct quotes, and meaningful lists.",
      "3. Remove navigation, ads, newsletter boxes, cookie banners, social share widgets, scripts, recommendations, and unrelated boilerplate.",
      "4. Do not summarize or invent missing/paywalled paragraphs.",
      "5. If the payload is a login page, bot-block page, paywall, privacy policy, homepage, or unrelated page, return NEEDS_MANUAL_REVIEW with the reason.",
      `STRICTNESS\n${strictnessRule}${mustIncludeBlock}${mustAvoidBlock}`,
    ].join("\n\n");
  }

  if (input.promptKind === "summary-alignment") {
    return [
      `ROLE\nYou are ${audience}.`,
      `TASK\nCompare recovered article text against the dataset summary for this goal:\n${goal}`,
      "ALIGNMENT CHECKLIST",
      "1. Identify the main topic, event, actors, date/timeframe, and location in the recovered article.",
      "2. Identify the same elements in the provided dataset summary.",
      "3. Score summary_alignment_score from 0-100. Use 0-30 for unrelated pages, 31-70 for partial/mixed alignment, and 71-100 for strong alignment.",
      "4. Flag wrong pages, bot blocks, login walls, archive shells, privacy pages, and severe truncation.",
      "5. Explain the alignment score in one concise evidence-grounded sentence.",
      `STRICTNESS\n${strictnessRule}${mustIncludeBlock}${mustAvoidBlock}`,
    ].join("\n\n");
  }

  if (input.promptKind === "dataset-methods") {
    return [
      `ROLE\nYou are ${audience}.`,
      `TASK\nCreate dataset methods and coding guidance for this article corpus:\n${goal}`,
      "METHODS OUTPUT",
      "1. Inclusion criteria.",
      "2. Exclusion criteria.",
      "3. Variables to extract.",
      "4. Quality-control checks for duplicate titles, bad URLs, bot-block pages, paywalls, and summary mismatch.",
      "5. Coding rules for relevance and evidence strength.",
      "6. Recommended audit notes for manual review.",
      `STRICTNESS\n${strictnessRule}${mustIncludeBlock}${mustAvoidBlock}`,
    ].join("\n\n");
  }

  if (input.promptKind === "custom") {
    return [
      `ROLE\nYou are ${audience}.`,
      `USER GOAL\n${goal}`,
      "CUSTOM INSTRUCTION\nProduce a precise, reusable prompt for processing recovered news articles. Include role, task, definitions, inclusion/exclusion rules, evidence requirements, failure cases, and output format.",
      `STRICTNESS\n${strictnessRule}${mustIncludeBlock}${mustAvoidBlock}`,
    ].join("\n\n");
  }

  // Default evaluation rubric
  const datasetContext =
    options?.summaryColumn && options.summaryColumn !== "None"
      ? `\n\nDATASET CONTEXT\nUse the column "${options.summaryColumn}" as the original summary/snippet for alignment checks.`
      : "";

  return [
    `ROLE\nYou are ${audience}.`,
    `TASK\nEvaluate each recovered article according to this research goal:\n${goal}`,
    [
      "RUBRIC",
      "1. Source match: verify that the recovered text is the intended article, not a homepage, privacy policy, login page, bot-block page, archive shell, or unrelated article.",
      "2. Summary alignment: compare recovered article text to the original dataset summary/snippet. Score 0-30 if unrelated, 31-70 if partially aligned, and 71-100 if strongly aligned.",
      "3. Completeness: reward full article prose with clear headline/byline/date and multiple substantive paragraphs. Penalize truncation, boilerplate, and missing body text.",
      "4. Research relevance: score direct evidence highly and passing mentions weakly.",
      "5. Evidence extraction: identify key actors, institutions, dates, locations, claims, and direct quotes if visible.",
      "6. Uncertainty: do not infer hidden/paywalled content. Use NEEDS_MANUAL_REVIEW for partial or ambiguous cases.",
    ].join("\n"),
    "VALID STATUSES\nVERIFIED_PASSED, PARTIAL_TRUNCATED, FAILED_SUMMARY_ALIGNMENT, FLAGGED_PAYWALL_OR_ERROR, LOW_RELEVANCE, NEEDS_MANUAL_REVIEW.",
    `STRICTNESS\n${strictnessRule}${mustIncludeBlock}${mustAvoidBlock}${datasetContext}`,
  ].join("\n\n");
}

// ─── Generate Prompt From Input ───────────────────────────────────────────────

export async function generatePromptFromInput(
  input: PromptGeneratorInput,
  options: ProcessOptions,
): Promise<PromptGeneratorResult> {
  const fallback = localPromptFromInput(input, options);

  if (!safeString(input.userGoal)) {
    return {
      prompt:    fallback,
      usedAI:    false,
      provider:  options.aiProvider,
      model:     options.aiModel || "local-template",
      note:      "Generated locally because no goal was provided.",
    };
  }

  if (!input.useConnectedAI) {
    return {
      prompt:    fallback,
      usedAI:    false,
      provider:  options.aiProvider,
      model:     options.aiModel || "local-template",
      note:      "Generated locally without an API call.",
    };
  }

  const systemPrompt =
    "You are ArchiveLens Prompt Studio. Convert the user's plain-language " +
    "research need into a precise, copy/paste-ready prompt for a news article " +
    "recovery and verification pipeline. The prompt must be operational, " +
    "specific, and safe: evaluate only visible recovered text, avoid inventing " +
    "hidden/paywalled content, and include explicit scoring or output rules. " +
    "Return plain text only, no markdown fence.";

  const prompt = [
    `User goal:\n${input.userGoal}`,
    `Prompt kind: ${input.promptKind}`,
    `Audience: ${input.audience     || "research assistant"}`,
    `Strictness: ${input.strictness || "balanced"}`,
    `Must include: ${input.mustInclude || "not specified"}`,
    `Must avoid: ${input.mustAvoid   || "not specified"}`,
    "",
    "Create the strongest possible ArchiveLens prompt under 650 words. " +
      "Include role, task, inclusion/exclusion criteria, scoring rules or " +
      "output format, failure cases, and anti-hallucination instructions.",
  ].join("\n");

  try {
    if (!apiKeyFor(options)) throw new Error("No API key available.");

    const output =
      options.aiProvider === "gemini"
        ? await callGemini(prompt, systemPrompt, options, false)
        : await callOpenAi(prompt, systemPrompt, options, false);

    const clean = output
      .trim()
      .replace(/^```(?:text|markdown)?/i, "")
      .replace(/```$/i, "")
      .trim();

    if (!clean) throw new Error("Model returned an empty prompt.");

    return {
      prompt:   clean,
      usedAI:   true,
      provider: options.aiProvider,
      model:    options.aiModel || "default",
      note:     `Generated with ${providerLabel(options.aiProvider)}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      prompt:   fallback,
      usedAI:   false,
      provider: options.aiProvider,
      model:    options.aiModel || "local-template",
      note: `API prompt generation failed, so a local template was used. ${message.slice(0, 180)}`,
    };
  }
}
