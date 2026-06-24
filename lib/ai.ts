import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AiResult, ProcessOptions, PromptGeneratorInput, PromptGeneratorResult, Provider, RowRecord } from "@/types/archivelens";

const HUIT_DEFAULT_BASE_URL = "https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1";

function safeString(value: unknown): string {
  return String(value ?? "").trim();
}

function safeHttpBaseUrl(value: unknown): string | undefined {
  const raw = safeString(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}


function clampScore(value: unknown, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => safeString(item)).filter(Boolean).slice(0, 12);
  if (typeof value === "string" && value.trim()) return value.split(/[,|]\s*/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  return [];
}

function normalizeEvidence(value: unknown): Array<{ claim: string; quote: string; relevance: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const claim = safeString(record.claim ?? record.point ?? record.label);
      const quote = safeString(record.quote ?? record.evidence ?? record.text);
      const relevance = safeString(record.relevance ?? record.reason ?? record.note);
      if (!claim && !quote) return null;
      return { claim, quote, relevance };
    })
    .filter(Boolean)
    .slice(0, 8) as Array<{ claim: string; quote: string; relevance: string }>;
}

function providerLabel(provider: Provider): string {
  if (provider === "huit") return "OpenAI via HUIT";
  if (provider === "openai") return "OpenAI direct";
  return "Gemini";
}

function evidencePack(text: string, maxChars = 22_000): string {
  const clean = safeString(text);
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
    const start = Math.floor(Math.max(0, middle.length - sampleLen) * ((i + 1) / (sampleCount + 1)));
    samples.push(middle.slice(start, start + sampleLen).trim());
  }

  return `[BEGINNING OF ARTICLE]\n${front}\n\n[REPRESENTATIVE MIDDLE SAMPLES]\n${samples.filter(Boolean).join("\n\n--- MIDDLE SAMPLE ---\n\n")}\n\n[ENDING OF ARTICLE]\n${back}\n\n[NOTE: Article was longer than the model evidence pack.]`;
}

function fallbackAi(metadata: RowRecord, status: string, note: string): AiResult {
  const headline = safeString(metadata.extracted_headline ?? metadata.headline ?? metadata.title);
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
    rubric_version: "fallback",
    model_used: "",
    provider_used: "huit",
    analyzed_at: new Date().toISOString()
  };
}

function extractJson(raw: string): Record<string, unknown> {
  const clean = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Fall through to object extraction.
  }
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI did not return a JSON object.");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function normalizeAiJson(parsed: Record<string, unknown>, metadata: RowRecord, options: ProcessOptions): AiResult {
  const status = safeString(
    parsed.ai_verification_status ??
      parsed.status ??
      parsed.verification_status ??
      "UNKNOWN"
  ).toUpperCase();

  const executiveSummary = safeString(
    parsed.executive_summary ??
      parsed.deep_summary ??
      parsed.summary
  );

  const notes = safeString(
    parsed.summary_alignment_notes ??
      parsed.reasoning ??
      parsed.alignment_reasoning
  );

  const evidence = normalizeEvidence(
    parsed.evidence ??
      parsed.supporting_evidence ??
      parsed.evidence_quotes
  );

  return {
    quality_score: clampScore(parsed.quality_score, 50),
    summary_alignment_score: clampScore(parsed.summary_alignment_score, 0),
    extraction_completeness_score: clampScore(
      parsed.extraction_completeness_score ?? parsed.completeness_score,
      0
    ),
    article_relevance_score: clampScore(
      parsed.article_relevance_score ?? parsed.relevance_score,
      0
    ),
    source_reliability_score: clampScore(
      parsed.source_reliability_score ?? parsed.source_score,
      0
    ),
    national_outlet_confidence: clampScore(
      parsed.national_outlet_confidence,
      Boolean(parsed.is_national_outlet) ? 75 : 0
    ),
    outlet_country_confidence: clampScore(
      parsed.outlet_country_confidence,
      safeString(parsed.outlet_country) ? 70 : 0
    ),
    status,
    ai_verification_status: status,
    headline: safeString(
      parsed.headline ??
        metadata.extracted_headline ??
        metadata.headline ??
        metadata.title
    ),
    author: safeString(
      parsed.author ??
        metadata.extracted_author ??
        metadata.author
    ),
    is_national_outlet: Boolean(parsed.is_national_outlet),
    outlet_country: safeString(parsed.outlet_country ?? "Unknown") || "Unknown",
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
    analyzed_at: new Date().toISOString()
  };
}

function providerKeyField(provider: Provider): keyof ProcessOptions {
  if (provider === "gemini") return "geminiApiKey";
  if (provider === "openai") return "openaiApiKey";
  return "huitApiKey";
}

function manualApiKeyFor(options: ProcessOptions): string {
  const providerSpecific = options[providerKeyField(options.aiProvider)];
  return safeString(providerSpecific || options.aiApiKey);
}

function environmentApiKeyFor(provider: Provider): string {
  if (provider === "gemini") return process.env.GEMINI_API_KEY ?? "";
  if (provider === "huit") return process.env.HUIT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  return process.env.OPENAI_API_KEY ?? "";
}

export function apiKeyFor(options: ProcessOptions): string {
  const manualKey = manualApiKeyFor(options);
  const mode = options.apiCredentialMode ?? (manualKey ? "manual" : "environment");
  if (mode === "manual") return manualKey;
  return environmentApiKeyFor(options.aiProvider);
}

export function baseUrlFor(options: ProcessOptions): string | undefined {
  if (options.aiProvider === "huit") {
    return (
      safeHttpBaseUrl(options.huitBaseUrl)
      || safeHttpBaseUrl(options.aiBaseUrl)
      || safeHttpBaseUrl(process.env.HUIT_OPENAI_BASE_URL)
      || HUIT_DEFAULT_BASE_URL
    );
  }
  if (options.aiProvider === "openai") {
    return safeHttpBaseUrl(options.openaiBaseUrl) || safeHttpBaseUrl(options.aiBaseUrl);
  }
  return undefined;
}

export function credentialSourceFor(options: ProcessOptions): "manual" | "environment" {
  const manualKey = manualApiKeyFor(options);
  const mode = options.apiCredentialMode ?? (manualKey ? "manual" : "environment");
  return mode === "manual" ? "manual" : "environment";
}

function openAiClient(options: ProcessOptions): OpenAI {
  const apiKey = apiKeyFor(options);
  if (!apiKey) throw new Error(`Missing ${options.aiProvider === "huit" ? "HUIT/OpenAI" : "OpenAI"} API key.`);
  const defaultHeaders = options.aiProvider === "huit" && !apiKey.startsWith("sk-") ? { "api-key": apiKey, "x-api-key": apiKey } : undefined;
  const baseURL = baseUrlFor(options);
  try {
    return new OpenAI({ apiKey, baseURL, defaultHeaders });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not initialize ${providerLabel(options.aiProvider)} client. Check the API key and base URL. Base URL being used: ${baseURL || "OpenAI default"}. Details: ${detail}`);
  }
}

async function callOpenAi(prompt: string, systemPrompt: string, options: ProcessOptions, jsonMode: boolean): Promise<string> {
  const client = openAiClient(options);
  const model = options.aiModel || "gpt-4o-mini";
  const reasoningModel = /^(o1|o3|o4)/i.test(model);

  const response = await client.chat.completions.create({
    model,
    messages: reasoningModel
      ? [{ role: "user", content: `${systemPrompt}\n\n---\n\n${prompt}` }]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
    ...(reasoningModel ? {} : { temperature: jsonMode ? 0.1 : 0.35, ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}) })
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callGemini(prompt: string, systemPrompt: string, options: ProcessOptions, jsonMode: boolean): Promise<string> {
  const apiKey = apiKeyFor(options);
  if (!apiKey) throw new Error("Missing Gemini API key.");

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: options.aiModel || "gemini-1.5-flash" });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n---\n\n${prompt}` }] }],
    generationConfig: { temperature: jsonMode ? 0.1 : 0.35, ...(jsonMode ? { responseMimeType: "application/json" } : {}) }
  });

  return result.response.text();
}

export async function testAiConnection(options: ProcessOptions): Promise<{ ok: boolean; message: string; provider: Provider; model: string; credentialSource: "manual" | "environment" }> {
  const provider = options.aiProvider;
  const model = options.aiModel || (provider === "gemini" ? "gemini-1.5-flash" : "gpt-4o-mini");
  const credentialSource = credentialSourceFor(options);

  try {
    if (provider === "gemini") {
      const apiKey = apiKeyFor(options);
      if (!apiKey) throw new Error("Missing Gemini API key. Paste one in the API Console or set GEMINI_API_KEY in Vercel.");
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model });
      const result = await genModel.generateContent({
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ArchiveLens connected" }] }],
        generationConfig: { temperature: 0 }
      });
      const text = result.response.text().trim();
      return { ok: true, message: `${providerLabel(provider)} connected with ${model}. Response: ${text || "OK"}`, provider, model, credentialSource };
    }

    const client = openAiClient({ ...options, aiModel: model });
    const reasoningModel = /^(o1|o3|o4)/i.test(model);
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with exactly: ArchiveLens connected" }],
      ...(reasoningModel ? {} : { temperature: 0 })
    });
    const text = response.choices[0]?.message?.content?.trim() || "OK";
    return { ok: true, message: `${providerLabel(provider)} connected with ${model}. Response: ${text}`, provider, model, credentialSource };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, provider, model, credentialSource };
  }
}

export async function analyzeArticle(row: RowRecord, options: ProcessOptions): Promise<AiResult> {
  const text = safeString(row.fetched_text);
  if (!options.enableAI) return fallbackAi(row, "AI_DISABLED", "AI verification was not enabled for this run.");
  if (!text || text.length < 50) return fallbackAi(row, "REJECTED_EMPTY_TEXT", "Recovered text is empty or too short to analyze.");

  const summaryColumn = options.summaryColumn && options.summaryColumn !== "None" ? options.summaryColumn : "";
  const providedSummary = summaryColumn ? safeString(row[summaryColumn]) : "";
  const customRubric = safeString(options.customRubric) || "Evaluate whether the recovered article is complete, relevant, and aligned with the provided dataset summary.";

  const systemPrompt = `You are ArchiveLens v3, an evidence-linked article verification and triage engine. Evaluate only the visible recovered text. Do not infer hidden/paywalled content. If the text is a paywall, login screen, bot-block page, privacy policy, archive shell, or unrelated page, flag it. Return only valid JSON with these keys: quality_score, extraction_completeness_score, article_relevance_score, source_reliability_score, summary_alignment_score, summary_alignment_notes, ai_verification_status, headline, author, is_national_outlet, national_outlet_confidence, outlet_country, outlet_country_confidence, executive_summary, key_entities, key_quotes, evidence, tone_and_bias, rubric_version. evidence must be an array of objects with claim, quote, and relevance, using only short quotes visibly present in the recovered text. Valid ai_verification_status values: VERIFIED_PASSED, PARTIAL_TRUNCATED, FAILED_SUMMARY_ALIGNMENT, FLAGGED_PAYWALL_OR_ERROR, LOW_RELEVANCE, NEEDS_MANUAL_REVIEW. Apply this user rubric strictly: ${customRubric}`;

  const prompt = `URL: ${safeString(row.source_url_used ?? row.url ?? row.link)}\nVisible title metadata: ${safeString(row.extracted_headline ?? row.headline ?? row.title)}\nVisible author metadata: ${safeString(row.extracted_author ?? row.author)}\nRecovery label: ${safeString(row.quality_label)}\nProvided original summary from dataset: ${providedSummary || "None provided"}\n\nRecovered article evidence pack:\n${evidencePack(text)}`;

  try {
    const raw = options.aiProvider === "gemini" ? await callGemini(prompt, systemPrompt, options, true) : await callOpenAi(prompt, systemPrompt, options, true);
    return normalizeAiJson(extractJson(raw), row, options);
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    return fallbackAi(row, "API_ERROR", note.slice(0, 500));
  }
}

function localPromptFromInput(input: PromptGeneratorInput, options?: ProcessOptions): string {
  const goal = safeString(input.userGoal) || "Evaluate recovered articles for relevance, completeness, and summary alignment.";
  const audience = safeString(input.audience) || "a meticulous research assistant";
  const include = safeString(input.mustInclude);
  const avoid = safeString(input.mustAvoid);
  const strictness = input.strictness || "balanced";

  const strictnessRule =
    strictness === "strict"
      ? "Use conservative thresholds. Penalize uncertainty, weak evidence, partial text, and summary mismatch heavily."
      : strictness === "creative"
        ? "Allow thoughtful synthesis, but every claim must still be grounded in visible recovered text."
        : "Balance precision with practical judgment for mixed-quality media archives.";

  if (input.promptKind === "article-recovery") {
    return `ROLE\nYou are ${audience}.\n\nTASK\nRecover clean article prose for this goal:\n${goal}\n\nEXTRACTION RULES\n1. Use only text visibly present in the recovered HTML or page text.\n2. Preserve headline, byline, publication date, headings, paragraph order, direct quotes, and meaningful lists.\n3. Remove navigation, ads, newsletter boxes, cookie banners, social share widgets, scripts, recommendations, and unrelated boilerplate.\n4. Do not summarize or invent missing/paywalled paragraphs.\n5. If the payload is a login page, bot-block page, paywall, privacy policy, homepage, or unrelated page, return NEEDS_MANUAL_REVIEW with the reason.\n\nSTRICTNESS\n${strictnessRule}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}`;
  }

  if (input.promptKind === "summary-alignment") {
    return `ROLE\nYou are ${audience}.\n\nTASK\nCompare recovered article text against the dataset summary for this goal:\n${goal}\n\nALIGNMENT CHECKLIST\n1. Identify the main topic, event, actors, date/timeframe, and location in the recovered article.\n2. Identify the same elements in the provided dataset summary.\n3. Score summary_alignment_score from 0-100. Use 0-30 for unrelated pages, 31-70 for partial/mixed alignment, and 71-100 for strong alignment.\n4. Flag wrong pages, bot blocks, login walls, archive shells, privacy pages, and severe truncation.\n5. Explain the alignment score in one concise evidence-grounded sentence.\n\nSTRICTNESS\n${strictnessRule}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}`;
  }

  if (input.promptKind === "dataset-methods") {
    return `ROLE\nYou are ${audience}.\n\nTASK\nCreate dataset methods and coding guidance for this article corpus:\n${goal}\n\nMETHODS OUTPUT\n1. Inclusion criteria.\n2. Exclusion criteria.\n3. Variables to extract.\n4. Quality-control checks for duplicate titles, bad URLs, bot-block pages, paywalls, and summary mismatch.\n5. Coding rules for relevance and evidence strength.\n6. Recommended audit notes for manual review.\n\nSTRICTNESS\n${strictnessRule}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}`;
  }

  if (input.promptKind === "custom") {
    return `ROLE\nYou are ${audience}.\n\nUSER GOAL\n${goal}\n\nCUSTOM INSTRUCTION\nProduce a precise, reusable prompt for processing recovered news articles. Include role, task, definitions, inclusion/exclusion rules, evidence requirements, failure cases, and output format.\n\nSTRICTNESS\n${strictnessRule}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}`;
  }

  return `ROLE\nYou are ${audience}.\n\nTASK\nEvaluate each recovered article according to this research goal:\n${goal}\n\nRUBRIC\n1. Source match: verify that the recovered text is the intended article, not a homepage, privacy policy, login page, bot-block page, archive shell, or unrelated article.\n2. Summary alignment: compare recovered article text to the original dataset summary/snippet. Score 0-30 if unrelated, 31-70 if partially aligned, and 71-100 if strongly aligned.\n3. Completeness: reward full article prose with clear headline/byline/date and multiple substantive paragraphs. Penalize truncation, boilerplate, and missing body text.\n4. Research relevance: score direct evidence highly and passing mentions weakly.\n5. Evidence extraction: identify key actors, institutions, dates, locations, claims, and direct quotes if visible.\n6. Uncertainty: do not infer hidden/paywalled content. Use NEEDS_MANUAL_REVIEW for partial or ambiguous cases.\n\nVALID STATUSES\nVERIFIED_PASSED, PARTIAL_TRUNCATED, FAILED_SUMMARY_ALIGNMENT, FLAGGED_PAYWALL_OR_ERROR, LOW_RELEVANCE, NEEDS_MANUAL_REVIEW.\n\nSTRICTNESS\n${strictnessRule}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}${options?.summaryColumn && options.summaryColumn !== "None" ? `\n\nDATASET CONTEXT\nUse the column \"${options.summaryColumn}\" as the original summary/snippet for alignment checks.` : ""}`;
}

export async function generatePromptFromInput(input: PromptGeneratorInput, options: ProcessOptions): Promise<PromptGeneratorResult> {
  const fallback = localPromptFromInput(input, options);
  if (!safeString(input.userGoal)) {
    return { prompt: fallback, usedAI: false, provider: options.aiProvider, model: options.aiModel || "local-template", note: "Generated locally because no goal was provided." };
  }
  if (!input.useConnectedAI) {
    return { prompt: fallback, usedAI: false, provider: options.aiProvider, model: options.aiModel || "local-template", note: "Generated locally without an API call." };
  }

  const systemPrompt = "You are ArchiveLens Prompt Studio. Convert the user's plain-language research need into a precise, copy/paste-ready prompt for a news article recovery and verification pipeline. The prompt must be operational, specific, and safe: evaluate only visible recovered text, avoid inventing hidden/paywalled content, and include explicit scoring or output rules. Return plain text only, no markdown fence.";
  const prompt = `User goal:\n${input.userGoal}\n\nPrompt kind: ${input.promptKind}\nAudience: ${input.audience || "research assistant"}\nStrictness: ${input.strictness || "balanced"}\nMust include: ${input.mustInclude || "not specified"}\nMust avoid: ${input.mustAvoid || "not specified"}\n\nCreate the strongest possible ArchiveLens prompt under 650 words. Include role, task, inclusion/exclusion criteria, scoring rules or output format, failure cases, and anti-hallucination instructions.`;

  try {
    if (!apiKeyFor(options)) throw new Error("No API key available.");
    const output = options.aiProvider === "gemini" ? await callGemini(prompt, systemPrompt, options, false) : await callOpenAi(prompt, systemPrompt, options, false);
    const clean = output.trim().replace(/^```(?:text|markdown)?/i, "").replace(/```$/i, "").trim();
    if (!clean) throw new Error("Model returned an empty prompt.");
    return { prompt: clean, usedAI: true, provider: options.aiProvider, model: options.aiModel || "default", note: `Generated with ${providerLabel(options.aiProvider)}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { prompt: fallback, usedAI: false, provider: options.aiProvider, model: options.aiModel || "local-template", note: `API prompt generation failed, so a local template was used. ${message.slice(0, 180)}` };
  }
}
