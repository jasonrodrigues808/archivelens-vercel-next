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
        record.relevance ?? record.reason ?? record.note ?? record.explanation,
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

function evidencePack(text: string, maxChars = 22_000): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;

  const frontBudget = Math.floor(maxChars * 0.42);
  const backBudget = Math.floor(maxChars * 0.3);
  const middleBudget = maxChars - frontBudget - backBudget - 700;

  const front = clean.slice(0, frontBudget);
  const back = clean.slice(-backBudget);
  const middle = clean.slice(frontBudget, -backBudget);

  const samples: string[] = [];
  const sampleCount = 3;
  const sampleLen = Math.max(400, Math.floor(middleBudget / sampleCount));

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
    quality_score: 0,
    summary_alignment_score: 0,
    extraction_completeness_score: 0,
    article_relevance_score: 0,
    source_reliability_score: 0,
    national_outlet_confidence: 0,
    outlet_country_confidence: 0,
    status,
    ai_verification_status: status,
    headline,
    author,
    is_national_outlet: false,
    outlet_country: "Unknown",
    executive_summary: "",
    deep_summary: "",
    reasoning: note,
    summary_alignment_notes: note,
    key_entities: [],
    key_quotes: [],
    evidence: [],
    evidence_json: "[]",
    evidence_count: 0,
    tone_and_bias: "",
    rubric_version: "archivelens-v3-fallback",
    model_used: options?.aiModel ?? "",
    provider_used: options?.aiProvider ?? "huit", // ← fixed: uses real provider
    analyzed_at: new Date().toISOString(),
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

// ─── Normalize AI JSON ────────────────────────────────────────────────────────

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
    parsed.evidence ?? parsed.supporting_evidence ?? parsed.evidence_quotes,
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
    is_national_outlet: isNationalOutlet,
    outlet_country: outletCountry,
    executive_summary: executiveSummary,
    deep_summary: executiveSummary,
    reasoning: notes,
    summary_alignment_notes: notes,
    key_entities: normalizeList(parsed.key_entities),
    key_quotes: normalizeList(parsed.key_quotes),
    evidence,
    evidence_json: JSON.stringify(evidence),
    evidence_count: evidence.length,
    tone_and_bias: safeString(parsed.tone_and_bias),
    rubric_version: safeString(parsed.rubric_version ?? "archivelens-v3"),
    model_used: safeString(options.aiModel),
    provider_used: options.aiProvider,
    analyzed_at: new Date().toISOString(),
  };
}

// ─── Credential Helpers ───────────────────────────────────────────────────────

function manualApiKeyFor(options: ProcessOptions): string {
  if (options.aiProvider === "gemini") return safeString(options.geminiApiKey);
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

// ─── Client Factories ─────────────────────────────────────────────────────────

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

  return new OpenAI({ apiKey, baseURL: baseUrlFor(options), defaultHeaders });
}

// ─── Retry Logic ──────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error instanceof Error &&
        (error.message.includes("rate_limit") ||
          error.message.includes("529") ||
          error.message.includes("503") ||
          error.message.includes("timeout"));
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
        ? [{ role: "user", content: `$${systemPrompt}\n\n---\n\n$${prompt}` }]
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
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
  const model = client.getGenerativeModel({
    model: options.aiModel || "gemini-1.5-flash",
  });

  const result = await withRetry(() =>
    model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: `$${systemPrompt}\n\n---\n\n$${prompt}` }],
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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function testAiConnection(options: ProcessOptions): Promise<{
  ok: boolean;
  message: string;
  provider: Provider;
  model: string;
  credentialSource: "manual" | "environment";
}> {
  const provider = options.aiProvider;
  const model =
    options.aiModel ||
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
            role: "user",
            parts: [{ text: "Reply with exactly: ArchiveLens connected" }],
          },
        ],
        generationConfig: { temperature: 0 },
      });
      const text = result.response.text().trim();
      return {
        ok: true,
        message: `$${providerLabel(provider)} connected with $${model}. Response: ${text || "OK"}`,
        provider,
        model,
        credentialSource,
      };
    }

    const client = openAiClient({ ...options, aiModel: model });
    const reasoningModel = /^(o1|o3|o4)/i.test(model);
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "user", content: "Reply with exactly: ArchiveLens connected" },
      ],
      ...(reasoningModel ? {} : { temperature: 0 }),
    });
    const text = response.choices[0]?.message?.content?.trim() || "
