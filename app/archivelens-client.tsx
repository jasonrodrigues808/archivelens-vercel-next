"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import { detectSummaryColumn, detectTitleColumn, detectUrlColumn, parseCsvText, unparseCsv } from "@/lib/csv";
import { duplicateGroupStats } from "@/lib/dedupe";
import type {
  ProcessOptions,
  ProcessResponse,
  PromptGeneratorInput,
  PromptGeneratorResult,
  PromptKind,
  PromptStrictness,
  Provider,
  RowRecord
} from "@/types/archivelens";

const modelOptionsByProvider: Record<Provider, string[]> = {
  huit: ["gpt-4o-mini", "gpt-4o", "o3-mini", "o4-mini"],
  openai: ["gpt-4o-mini", "gpt-4o", "o3-mini", "o4-mini"],
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"]
};

const providerLabels: Record<Provider, string> = {
  huit: "OpenAI via HUIT",
  openai: "OpenAI direct",
  gemini: "Google Gemini"
};

const providerSubtitles: Record<Provider, string> = {
  huit: "Harvard gateway / OpenAI-compatible",
  openai: "Direct OpenAI API key",
  gemini: "Google Generative AI key"
};

const initialOptions: ProcessOptions = {
  urlColumn: "",
  titleColumn: "None",
  summaryColumn: "None",
  duplicateGroupColumn: "None",
  recoveryRoute: "balanced",
  performanceProfile: "fast",
  concurrency: 6,
  retries: 2,
  timeoutMs: 12_000,
  minChars: 300,
  respectRobots: true,
  useJina: true,
  useWayback: false,
  authorizedCookie: "",
  enableAI: false,
  reuseDuplicateAI: true,
  aiProvider: "huit",
  aiModel: "gpt-4o-mini",
  customRubric: "Evaluate whether the recovered article is complete, relevant, and aligned with the provided dataset summary. Penalize boilerplate, login pages, unrelated pages, bot-block pages, severe truncation, and unsupported claims.",
  apiCredentialMode: "environment",
  aiApiKey: "",
  aiBaseUrl: "",
  huitApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  huitBaseUrl: "https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1",
  openaiBaseUrl: ""
};

type ApiTestStatus = "idle" | "testing" | "success" | "error";
type ApiTestState = Record<Provider, { status: ApiTestStatus; message: string; credentialSource?: string }>;
type ResultPanel = "table" | "reader" | "log" | "guide";
type NationalFilter = "any" | "national" | "not-national";
type SortMode = "quality-desc" | "alignment-desc" | "words-desc" | "headline-asc" | "country-asc";
type FilterPreset = "all" | "high-quality" | "us-national" | "manual-review" | "bot-blocked" | "low-alignment";

function defaultModelFor(provider: Provider): string {
  return modelOptionsByProvider[provider][0];
}

function downloadBlob(filename: string, content: BlobPart, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function compact(value: unknown, max = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function pillClass(label: unknown): string {
  const lower = String(label ?? "").toLowerCase();
  if (/(full|verified|passed|complete|success|connected|entered|manual)/.test(lower)) return "pill good";
  if (/(partial|manual|low|truncated|needs|testing|environment|local)/.test(lower)) return "pill warn";
  if (/(failed|error|auth|paywall|rate|robots|bot|missing|blocked)/.test(lower)) return "pill bad";
  return "pill info";
}

function numberValue(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return ["true", "yes", "1", "y", "national"].includes(text);
}

function normalizedCountry(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase();
  if (["us", "u.s.", "u.s.a.", "usa", "united states", "united states of america", "america"].includes(lower)) return "United States";
  if (["uk", "u.k.", "great britain", "britain"].includes(lower)) return "United Kingdom";
  return raw;
}

function isUnitedStatesCountry(value: unknown): boolean {
  return normalizedCountry(value).toLowerCase() === "united states";
}

function rowHeadline(row: RowRecord): string {
  return compact(row.headline || row.extracted_headline || row.title || row.name || "Untitled article", 140);
}

function averageScore(rows: RowRecord[], column: string): number | null {
  const values = rows.map((row) => numberValue(row[column], NaN)).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function manualKeyFor(options: ProcessOptions, provider: Provider): string {
  if (provider === "gemini") return options.geminiApiKey || "";
  if (provider === "openai") return options.openaiApiKey || "";
  return options.huitApiKey || "";
}

function activeApiReady(options: ProcessOptions): boolean {
  if (options.apiCredentialMode === "environment") return true;
  return Boolean(manualKeyFor(options, options.aiProvider).trim() || options.aiApiKey?.trim());
}

function localPromptPreview(input: PromptGeneratorInput): string {
  const goal = input.userGoal.trim() || "Evaluate article quality, relevance, and summary alignment.";
  const audience = input.audience?.trim() || "a careful research assistant";
  const include = input.mustInclude?.trim();
  const avoid = input.mustAvoid?.trim();
  const strictness = input.strictness || "balanced";
  const intro: Record<PromptKind, string> = {
    "ai-rubric": "Use the following rubric when verifying recovered news articles.",
    "article-recovery": "Use the following extraction instructions when cleaning visible article text.",
    "summary-alignment": "Use the following checklist to compare recovered article text against a dataset summary.",
    "dataset-methods": "Use the following methods prompt to audit a large article dataset.",
    custom: "Use the following prompt as a structured instruction."
  };
  return `${intro[input.promptKind]}\n\nROLE\nYou are ${audience}. Your objective is: ${goal}\n\nRULES\n1. Evaluate only visible text and metadata.\n2. Flag paywalls, login pages, bot-block pages, privacy pages, unrelated pages, and severe truncation.\n3. Separate evidence from interpretation.\n4. Score quality and alignment conservatively when the recovered text is incomplete.\n5. Return concise, auditable output.\n\nSTRICTNESS\n${strictness === "strict" ? "Use strict thresholds and penalize uncertainty." : strictness === "creative" ? "Allow thoughtful synthesis when evidence supports it." : "Balance precision with practical judgment."}${include ? `\n\nMUST INCLUDE\n${include}` : ""}${avoid ? `\n\nMUST AVOID\n${avoid}` : ""}\n\nDo not invent missing article text.`;
}

async function makeDocx(rows: RowRecord[]): Promise<Blob> {
  const summaryRows = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: ["#", "Headline", "Recovery", "AI status", "Score"].map(
          (text) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] })
        )
      }),
      ...rows.slice(0, 500).map(
        (row, index) =>
          new TableRow({
            children: [
              String(index + 1),
              compact(row.headline || row.extracted_headline || row.title, 80),
              String(row.quality_label ?? ""),
              String(row.status ?? row.ai_verification_status ?? ""),
              String(row.quality_score ?? "")
            ].map((text) => new TableCell({ children: [new Paragraph({ text })] }))
          })
      )
    ]
  });

  const children = [
    new Paragraph({ text: "ArchiveLens Executive Briefing", heading: HeadingLevel.TITLE }),
    new Paragraph(`Generated from ${rows.length.toLocaleString()} processed rows.`),
    new Paragraph({ text: "Processing Summary", heading: HeadingLevel.HEADING_1 }),
    summaryRows,
    new Paragraph({ text: "Recovered Articles", heading: HeadingLevel.HEADING_1 }),
    ...rows.slice(0, 250).flatMap((row, index) => [
      new Paragraph({ text: `${index + 1}. ${compact(row.headline || row.extracted_headline || row.title || "Untitled", 140)}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [new TextRun({ text: "Source: ", bold: true }), new TextRun(String(row.source_url_used || row.url || row.link || ""))] }),
      new Paragraph({ children: [new TextRun({ text: "Recovery: ", bold: true }), new TextRun(String(row.quality_label || ""))] }),
      new Paragraph({ children: [new TextRun({ text: "AI status: ", bold: true }), new TextRun(String(row.status || row.ai_verification_status || "not analyzed"))] }),
      new Paragraph({ children: [new TextRun({ text: "Executive summary: ", bold: true }), new TextRun(compact(row.executive_summary || row.deep_summary || "", 1200))] }),
      new Paragraph({ text: compact(row.fetched_text || "No recovered text.", 3500) })
    ])
  ];

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBlob(doc);
}

export default function ArchiveLensClient() {
  const [csvText, setCsvText] = useState("");
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [options, setOptions] = useState<ProcessOptions>(initialOptions);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [minQuality, setMinQuality] = useState(0);
  const [minAlignment, setMinAlignment] = useState(0);
  const [minWords, setMinWords] = useState(0);
  const [nationalFilter, setNationalFilter] = useState<NationalFilter>("any");
  const [countryFilter, setCountryFilter] = useState("Any");
  const [recoveryFilter, setRecoveryFilter] = useState("Any");
  const [statusFilter, setStatusFilter] = useState("Any");
  const [sortMode, setSortMode] = useState<SortMode>("quality-desc");
  const [onlyDuplicateGroups, setOnlyDuplicateGroups] = useState(false);
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [resultPanel, setResultPanel] = useState<ResultPanel>("table");
  const [apiTest, setApiTest] = useState<ApiTestState>({
    huit: { status: "idle", message: "Not tested yet." },
    openai: { status: "idle", message: "Not tested yet." },
    gemini: { status: "idle", message: "Not tested yet." }
  });
  const [promptInput, setPromptInput] = useState<PromptGeneratorInput>({
    userGoal: "Find climate policy articles that discuss misinformation, disasters, public opinion, fossil fuel campaigns, or government response.",
    promptKind: "ai-rubric",
    audience: "a meticulous climate-policy research assistant",
    strictness: "balanced",
    mustInclude: "Quality score, summary-alignment score, why the article is relevant, key actors, and whether the text appears complete.",
    mustAvoid: "Do not reward pages that are mostly ads, navigation, login walls, bot-block pages, or unrelated evergreen pages.",
    useConnectedAI: true
  });
  const [generatedPrompt, setGeneratedPrompt] = useState<PromptGeneratorResult | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState("");

  const stats = useMemo(
    () => duplicateGroupStats(rows, options.duplicateGroupColumn || "None"),
    [rows, options.duplicateGroupColumn]
  );

  const previewRows = rows.slice(0, 5);
  const outputRows = result?.rows ?? [];

  const countryOptions = useMemo(() => {
    const countries = new Set<string>();
    outputRows.forEach((row) => countries.add(normalizedCountry(row.outlet_country)));
    return ["Any", ...Array.from(countries).sort((a, b) => a.localeCompare(b))];
  }, [outputRows]);

  const recoveryOptions = useMemo(() => {
    const labels = new Set<string>();
    outputRows.forEach((row) => labels.add(String(row.quality_label ?? "unknown")));
    return ["Any", ...Array.from(labels).filter(Boolean).sort((a, b) => a.localeCompare(b))];
  }, [outputRows]);

  const statusOptions = useMemo(() => {
    const statuses = new Set<string>();
    outputRows.forEach((row) => statuses.add(String(row.status ?? row.ai_verification_status ?? "not analyzed")));
    return ["Any", ...Array.from(statuses).filter(Boolean).sort((a, b) => a.localeCompare(b))];
  }, [outputRows]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rowsAfterFilter = outputRows.filter((row) => {
      if (needle) {
        const haystack = [
          row.extracted_headline,
          row.headline,
          row.title,
          row.source_url_used,
          row.canonical_url,
          row.extracted_site_name,
          row.outlet_country,
          row.status,
          row.ai_verification_status,
          row.quality_label,
          row.executive_summary,
          row.reasoning,
          row.fetched_text
        ]
          .map((value) => String(value ?? "").toLowerCase())
          .join(" ");
        if (!haystack.includes(needle)) return false;
      }

      if (numberValue(row.quality_score, 0) < minQuality) return false;
      if (numberValue(row.summary_alignment_score, 0) < minAlignment) return false;
      if (numberValue(row.word_count, 0) < minWords) return false;

      const isNational = boolValue(row.is_national_outlet);
      if (nationalFilter === "national" && !isNational) return false;
      if (nationalFilter === "not-national" && isNational) return false;

      if (countryFilter !== "Any") {
        if (countryFilter === "United States") {
          if (!isUnitedStatesCountry(row.outlet_country)) return false;
        } else if (normalizedCountry(row.outlet_country).toLowerCase() !== countryFilter.toLowerCase()) {
          return false;
        }
      }

      if (recoveryFilter !== "Any" && String(row.quality_label ?? "") !== recoveryFilter) return false;
      if (statusFilter !== "Any" && String(row.status ?? row.ai_verification_status ?? "not analyzed") !== statusFilter) return false;
      if (onlyDuplicateGroups && numberValue(row._archivelens_dedupe_group_size, 1) < 2) return false;

      return true;
    });

    return [...rowsAfterFilter].sort((a, b) => {
      if (sortMode === "quality-desc") return numberValue(b.quality_score, 0) - numberValue(a.quality_score, 0);
      if (sortMode === "alignment-desc") return numberValue(b.summary_alignment_score, 0) - numberValue(a.summary_alignment_score, 0);
      if (sortMode === "words-desc") return numberValue(b.word_count, 0) - numberValue(a.word_count, 0);
      if (sortMode === "headline-asc") return rowHeadline(a).localeCompare(rowHeadline(b));
      if (sortMode === "country-asc") return normalizedCountry(a.outlet_country).localeCompare(normalizedCountry(b.outlet_country));
      return 0;
    });
  }, [outputRows, search, minQuality, minAlignment, minWords, nationalFilter, countryFilter, recoveryFilter, statusFilter, onlyDuplicateGroups, sortMode]);

  const filteredStats = useMemo(() => {
    const fullText = filteredRows.filter((row) => row.quality_label === "full_text").length;
    const national = filteredRows.filter((row) => boolValue(row.is_national_outlet)).length;
    const usNational = filteredRows.filter((row) => boolValue(row.is_national_outlet) && isUnitedStatesCountry(row.outlet_country)).length;
    return {
      filteredCount: filteredRows.length,
      fullText,
      national,
      usNational,
      meanQuality: averageScore(filteredRows, "quality_score"),
      meanAlignment: averageScore(filteredRows, "summary_alignment_score")
    };
  }, [filteredRows]);

  const selectedRow = filteredRows.length ? filteredRows[Math.min(selectedRowIndex, filteredRows.length - 1)] : null;

  const visibleColumns = [
    "quality_label",
    "status",
    "quality_score",
    "summary_alignment_score",
    "is_national_outlet",
    "outlet_country",
    "extracted_headline",
    "headline",
    "source_url_used",
    "recovery_route",
    "word_count",
    "_archivelens_dedupe_group_size",
    "executive_summary",
    "error_message"
  ].filter((column, index, arr) => arr.indexOf(column) === index && (result?.columns.includes(column) || outputRows.some((row) => column in row)));

  const runReadiness = [
    { label: "CSV", ok: rows.length > 0, note: rows.length ? `${rows.length.toLocaleString()} rows loaded` : "Upload a manifest" },
    { label: "URL", ok: Boolean(options.urlColumn), note: options.urlColumn || "Choose URL column" },
    { label: "Dedupe", ok: Boolean(options.duplicateGroupColumn && options.duplicateGroupColumn !== "None"), note: stats.requestsSaved ? `${stats.requestsSaved.toLocaleString()} requests saved` : "Optional" },
    { label: "AI", ok: !options.enableAI || activeApiReady(options), note: options.enableAI ? `${providerLabels[options.aiProvider]} selected` : "Disabled" }
  ];

  function updateOption<K extends keyof ProcessOptions>(key: K, value: ProcessOptions[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function updatePrompt<K extends keyof PromptGeneratorInput>(key: K, value: PromptGeneratorInput[K]) {
    setPromptInput((prev) => ({ ...prev, [key]: value }));
  }

  function updateProvider(provider: Provider) {
    setOptions((prev) => ({
      ...prev,
      aiProvider: provider,
      aiModel: modelOptionsByProvider[provider].includes(prev.aiModel) ? prev.aiModel : defaultModelFor(provider)
    }));
  }

  async function onFileChange(file: File | undefined) {
    setError("");
    setResult(null);
    if (!file) return;

    const text = await file.text();
    const parsedRows = parseCsvText(text);
    const parsedColumns = Object.keys(parsedRows[0] ?? {});
    const autoUrl = detectUrlColumn(parsedColumns);
    const autoTitle = detectTitleColumn(parsedColumns);
    const autoSummary = detectSummaryColumn(parsedColumns);

    setCsvText(text);
    setRows(parsedRows);
    setColumns(parsedColumns);
    setOptions((prev) => ({
      ...prev,
      urlColumn: autoUrl,
      titleColumn: autoTitle,
      duplicateGroupColumn: autoTitle,
      summaryColumn: autoSummary
    }));
  }

  async function testApiConnection(provider = options.aiProvider) {
    setApiTest((prev) => ({
      ...prev,
      [provider]: { status: "testing", message: `Testing ${providerLabels[provider]}...` }
    }));

    const testOptions: ProcessOptions = {
      ...options,
      urlColumn: options.urlColumn || "url",
      aiProvider: provider,
      aiModel: modelOptionsByProvider[provider].includes(options.aiModel) ? options.aiModel : defaultModelFor(provider),
      enableAI: true
    };

    try {
      const response = await fetch("/api/test-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ options: testOptions })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || "Connection failed.");
      setApiTest((prev) => ({
        ...prev,
        [provider]: {
          status: "success",
          message: `${payload.message || "Connected."} (${payload.credentialSource || "key"})`,
          credentialSource: payload.credentialSource
        }
      }));
    } catch (err) {
      setApiTest((prev) => ({
        ...prev,
        [provider]: { status: "error", message: err instanceof Error ? err.message : String(err) }
      }));
    }
  }

  async function generatePrompt() {
    setPromptError("");
    setPromptLoading(true);
    setGeneratedPrompt(null);

    try {
      if (!promptInput.userGoal.trim()) throw new Error("Describe what you want the prompt to do first.");

      if (!promptInput.useConnectedAI) {
        setGeneratedPrompt({
          prompt: localPromptPreview(promptInput),
          usedAI: false,
          provider: options.aiProvider,
          model: options.aiModel,
          note: "Generated locally without an API call."
        });
        return;
      }

      const response = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: promptInput, options: { ...options, enableAI: true } })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Prompt generation failed.");
      setGeneratedPrompt(payload as PromptGeneratorResult);
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function runPipeline() {
    setError("");
    setLoading(true);
    setResult(null);

    try {
      if (options.enableAI && !activeApiReady(options)) {
        throw new Error("AI is enabled, but no manual API key is entered for the selected provider. Enter a key or switch API credential mode to environment variables.");
      }
      if (!rows.length || !csvText.trim()) throw new Error("Upload a CSV first.");
      if (!options.urlColumn) throw new Error("Choose a URL column before running.");

      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText, options })
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Pipeline failed.");
      setResult(payload as ProcessResponse);
      setResultPanel("table");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function resetResultFilters() {
    setSearch("");
    setMinQuality(0);
    setMinAlignment(0);
    setMinWords(0);
    setNationalFilter("any");
    setCountryFilter("Any");
    setRecoveryFilter("Any");
    setStatusFilter("Any");
    setSortMode("quality-desc");
    setOnlyDuplicateGroups(false);
    setSelectedRowIndex(0);
  }

  function applyFilterPreset(preset: FilterPreset) {
    resetResultFilters();
    if (preset === "high-quality") {
      setMinQuality(80);
      setMinAlignment(70);
      setRecoveryFilter("full_text");
    } else if (preset === "us-national") {
      setNationalFilter("national");
      setCountryFilter("United States");
      setMinQuality(50);
    } else if (preset === "manual-review") {
      setRecoveryFilter("Any");
      setStatusFilter("NEEDS_MANUAL_REVIEW");
      setSortMode("alignment-desc");
    } else if (preset === "bot-blocked") {
      setRecoveryFilter("bot_blocked");
    } else if (preset === "low-alignment") {
      setMinQuality(0);
      setMinAlignment(0);
      setSortMode("alignment-desc");
      setSearch("FAILED_SUMMARY_ALIGNMENT");
    }
  }

  async function downloadDocx(rowsToExport?: RowRecord[]) {
    const rowsForDocx = rowsToExport ?? result?.rows ?? [];
    if (!rowsForDocx.length) return;
    const blob = await makeDocx(rowsForDocx);
    downloadBlob("archivelens_executive_briefing.docx", blob, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }

  return (
    <main className="shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="grid-noise" />

      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-orb">A</div>
          <div>
            <div className="brand-title">ArchiveLens</div>
            <div className="brand-subtitle">Vercel intelligence console</div>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={runReadiness.every((item) => item.ok || item.label === "Dedupe") ? "status-dot ok" : "status-dot"}>Run readiness</span>
          <span className={pillClass(options.apiCredentialMode)}>{options.apiCredentialMode === "environment" ? "env keys" : "session keys"}</span>
        </div>
      </header>

      <section className="hero command-hero">
        <div className="hero-copy">
          <div className="kicker"><span /> ArchiveLens Command OS</div>
          <h1>Recover, verify, and brief articles from one glowing console.</h1>
          <p>
            Upload a CSV, collapse duplicate titles, connect HUIT/OpenAI/Gemini, generate your own AI rubric, recover article text, and export a research-ready database.
          </p>
          <div className="button-row hero-buttons">
            <label className="btn file-button">
              <input type="file" accept=".csv,text/csv" onChange={(event) => onFileChange(event.target.files?.[0])} />
              Upload CSV
            </label>
            <button className="btn" disabled={!rows.length || loading} onClick={runPipeline}>{loading ? "Running pipeline..." : "Run pipeline"}</button>
            <button className="btn secondary" disabled={!result?.rows.length} onClick={() => result && downloadBlob("archivelens_processed.csv", unparseCsv(result.rows), "text/csv;charset=utf-8")}>Export CSV</button>
          </div>
        </div>
        <aside className="mission-card">
          <div className="mission-title">Mission control</div>
          {runReadiness.map((item) => (
            <div className="mission-step" key={item.label}>
              <span className={item.ok ? "step-light on" : "step-light"} />
              <div>
                <div>{item.label}</div>
                <small>{item.note}</small>
              </div>
            </div>
          ))}
          <div className="mission-divider" />
          <div className="mission-mini">
            <span>Selected model</span>
            <strong>{options.aiModel}</strong>
          </div>
        </aside>
      </section>

      <section className="section grid four">
        <Metric label="Rows loaded" value={rows.length.toLocaleString()} caption="from uploaded CSV" />
        <Metric label="Unique scrape jobs" value={stats.groups.toLocaleString()} caption={`${stats.requestsSaved.toLocaleString()} duplicate requests saved`} />
        <Metric label="Largest duplicate group" value={stats.largestGroup.toLocaleString()} caption="same normalized title" />
        <Metric label="Processed rows" value={(result?.rows.length ?? 0).toLocaleString()} caption="latest completed run" />
      </section>

      <section className="section grid dashboard">
        <div className="card panel data-panel">
          <SectionTitle number="01" title="Data manifest" help="Upload a CSV that contains article URLs. ArchiveLens auto-detects likely URL, title, and summary columns, but you can override all of them." />
          <label className="file-drop">
            <input type="file" accept=".csv,text/csv" onChange={(event) => onFileChange(event.target.files?.[0])} />
            <span>Drop or select CSV</span>
            <small>Required: URL column. Recommended: title/headline column and original summary/snippet column.</small>
          </label>

          {columns.length > 0 && (
            <div className="grid two section-tight">
              <SelectField label="URL column" help="This column is the source article URL fetched by the recovery engine." value={options.urlColumn} onChange={(value) => updateOption("urlColumn", value)} options={columns} />
              <SelectField label="Group duplicates before scraping" help="Pick the title/headline column. Rows with the same normalized title are scraped once, then expanded back to all original rows." value={options.duplicateGroupColumn || "None"} onChange={(value) => updateOption("duplicateGroupColumn", value)} options={["None", ...columns]} />
              <SelectField label="Title/headline column" help="Used for display, export, and fallback duplicate grouping." value={options.titleColumn || "None"} onChange={(value) => updateOption("titleColumn", value)} options={["None", ...columns]} />
              <SelectField label="Original summary/snippet" help="If selected, AI compares the recovered article to this original dataset summary. This catches wrong pages and duplicate-title mismatches." value={options.summaryColumn || "None"} onChange={(value) => updateOption("summaryColumn", value)} options={["None", ...columns]} />
            </div>
          )}

          {previewRows.length > 0 && (
            <div className="table-wrap preview-table section-tight">
              <table>
                <thead>
                  <tr>{columns.slice(0, 6).map((column) => <th key={column}>{column}</th>)}</tr>
                </thead>
                <tbody>
                  {previewRows.map((row, index) => (
                    <tr key={index}>{columns.slice(0, 6).map((column) => <td key={column}>{compact(row[column], 110)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card panel recovery-panel">
          <SectionTitle number="02" title="Recovery engine" help="These settings control how aggressively the app tries to retrieve visible article text. Fast mode is best for big CSVs; maximum recovery is slower." />
          <div className="grid two">
            <SelectField
              label="Recovery route"
              help="Balanced tries live, public reader, then archive. Fast skips archive. Archive first is useful for deleted or old articles."
              value={options.recoveryRoute}
              onChange={(value) => updateOption("recoveryRoute", value as ProcessOptions["recoveryRoute"])}
              options={[
                { value: "balanced", label: "Balanced: live + reader + archive" },
                { value: "fast", label: "Fast: live + reader only" },
                { value: "live-first", label: "Live first" },
                { value: "archive-first", label: "Archive first" },
                { value: "live-only", label: "Live only" },
                { value: "archive-only", label: "Archive only" }
              ]}
            />
            <SelectField
              label="Performance profile"
              help="Fast duplicate-aware reduces retries and waits. Maximum recovery gives slower fallbacks more room."
              value={options.performanceProfile}
              onChange={(value) => updateOption("performanceProfile", value as ProcessOptions["performanceProfile"])}
              options={[
                { value: "fast", label: "Fast duplicate-aware" },
                { value: "balanced", label: "Balanced" },
                { value: "maximum", label: "Maximum recovery" }
              ]}
            />
            <NumberField label="Concurrency" help="How many representative URLs are processed at once. Higher is faster, but too high can cause more 429s." min={1} max={12} value={options.concurrency} onChange={(value) => updateOption("concurrency", value)} />
            <NumberField label="Retries" help="How many times each route can retry after transient failures or 429 backoff." min={1} max={8} value={options.retries} onChange={(value) => updateOption("retries", value)} />
            <NumberField label="Timeout seconds" help="Maximum wait for a single HTTP request. Lower is faster; higher helps slow archives." min={3} max={60} value={Math.round(options.timeoutMs / 1000)} onChange={(value) => updateOption("timeoutMs", value * 1000)} />
            <NumberField label="Minimum article chars" help="Below this length, recovered text is labeled partial or failed rather than full_text." min={120} max={5000} value={options.minChars} onChange={(value) => updateOption("minChars", value)} />
          </div>

          <div className="switch-stack">
            <Switch checked={options.respectRobots} onChange={(checked) => updateOption("respectRobots", checked)} label="Respect robots.txt" help="When enabled, live-page scraping is skipped if robots.txt disallows it for this app's user agent." />
            <Switch checked={options.useJina} onChange={(checked) => updateOption("useJina", checked)} label="Public reader fallback" help="Tries a public reader service for JavaScript-heavy public pages. Usually faster than archives." />
            <Switch checked={options.useWayback} onChange={(checked) => updateOption("useWayback", checked)} label="Wayback fallback" help="Tries public archive snapshots. Better recovery for deleted or changed pages, but slower." />
          </div>

          <TextAreaField label="Authorized Cookie header" help="Only use this for accounts or content you are authorized to access. Leave blank for public-only recovery." value={options.authorizedCookie || ""} onChange={(value) => updateOption("authorizedCookie", value)} placeholder="Optional Cookie: key=value; key2=value2" />
        </div>

        <div className="card panel api-panel">
          <SectionTitle number="03" title="API Vault" help="Connect HUIT, OpenAI, or Gemini. Environment mode uses .env.local / Vercel variables. Manual mode lets you paste keys for this browser session." />
          <div className="credential-toggle">
            <button className={options.apiCredentialMode === "environment" ? "seg active" : "seg"} onClick={() => updateOption("apiCredentialMode", "environment")}>Use .env / Vercel</button>
            <button className={options.apiCredentialMode === "manual" ? "seg active" : "seg"} onClick={() => updateOption("apiCredentialMode", "manual")}>Paste keys here</button>
          </div>

          <div className="provider-grid section-tight">
            {(Object.keys(providerLabels) as Provider[]).map((provider) => (
              <button key={provider} className={options.aiProvider === provider ? "provider-card active" : "provider-card"} onClick={() => updateProvider(provider)}>
                <span>{providerLabels[provider]}</span>
                <small>{providerSubtitles[provider]}</small>
                <em className={pillClass(apiTest[provider].status)}>{apiTest[provider].status}</em>
              </button>
            ))}
          </div>

          <div className="grid two section-tight">
            <SelectField label="Model" help="Use a small/fast model for large batches. Use a stronger model for higher-quality summaries and difficult alignment checks." value={options.aiModel} onChange={(value) => updateOption("aiModel", value)} options={modelOptionsByProvider[options.aiProvider]} />
            <SelectField label="Active provider" help="The selected provider is used for AI verification and optional prompt generation." value={options.aiProvider} onChange={(value) => updateProvider(value as Provider)} options={(Object.keys(providerLabels) as Provider[]).map((provider) => ({ value: provider, label: providerLabels[provider] }))} />
          </div>

          {options.apiCredentialMode === "environment" ? (
            <div className="env-box section-tight">
              <div className="env-title">Add these variables locally and in Vercel</div>
              <code>HUIT_OPENAI_API_KEY</code>
              <code>OPENAI_API_KEY</code>
              <code>GEMINI_API_KEY</code>
              <code>HUIT_OPENAI_BASE_URL</code>
              <small>Use .env.local for local development and Vercel Project Settings for deployment.</small>
            </div>
          ) : (
            <div className="api-key-grid section-tight">
              <SecretField label="HUIT API key" provider="huit" value={options.huitApiKey || ""} onChange={(value) => updateOption("huitApiKey", value)} />
              <SecretField label="OpenAI API key" provider="openai" value={options.openaiApiKey || ""} onChange={(value) => updateOption("openaiApiKey", value)} />
              <SecretField label="Gemini API key" provider="gemini" value={options.geminiApiKey || ""} onChange={(value) => updateOption("geminiApiKey", value)} />
            </div>
          )}

          <div className="grid two section-tight">
            <TextField label="HUIT base URL" help="Only change this if your gateway endpoint changes." value={options.huitBaseUrl || ""} onChange={(value) => updateOption("huitBaseUrl", value)} />
            <TextField label="OpenAI base URL override" help="Usually blank. Use only for compatible gateways or proxies." value={options.openaiBaseUrl || ""} onChange={(value) => updateOption("openaiBaseUrl", value)} placeholder="Optional" />
          </div>

          <div className="switch-stack">
            <Switch checked={options.enableAI} onChange={(checked) => updateOption("enableAI", checked)} label="Enable AI verification" help="When enabled, every recovered article is checked for summary alignment, quality, outlet metadata, and executive summary. This adds cost and runtime." />
            <Switch checked={options.reuseDuplicateAI} onChange={(checked) => updateOption("reuseDuplicateAI", checked)} label="Reuse AI on duplicate groups" help="Rows with the same duplicate-title key and same original summary reuse one AI result. This saves money and speeds up large datasets." />
          </div>

          <div className="button-row section-tight">
            <button className="btn secondary" onClick={() => testApiConnection(options.aiProvider)} disabled={apiTest[options.aiProvider].status === "testing"}>
              {apiTest[options.aiProvider].status === "testing" ? "Testing..." : `Test ${providerLabels[options.aiProvider]}`}
            </button>
            <span className={pillClass(apiTest[options.aiProvider].status)}>{apiTest[options.aiProvider].status}</span>
          </div>
          <div className="api-message">{apiTest[options.aiProvider].message}</div>
        </div>

        <div className="card panel prompt-panel">
          <SectionTitle number="04" title="Prompt Studio" help="Describe what you want ArchiveLens to evaluate. It can generate a rigorous AI rubric or extraction prompt, then you can insert it directly into the verifier." />
          <TextAreaField label="What do you want the AI to do?" help="Write this casually. Example: find climate misinformation articles after hurricanes and score whether the article discusses fossil fuel actors." value={promptInput.userGoal} onChange={(value) => updatePrompt("userGoal", value)} />
          <div className="grid three section-tight">
            <SelectField label="Prompt type" help="AI rubric is the most useful option for the verifier. Other types are useful for method notes or specialized extraction instructions." value={promptInput.promptKind} onChange={(value) => updatePrompt("promptKind", value as PromptKind)} options={[
              { value: "ai-rubric", label: "AI verification rubric" },
              { value: "summary-alignment", label: "Summary alignment checklist" },
              { value: "article-recovery", label: "Article recovery instruction" },
              { value: "dataset-methods", label: "Dataset methods prompt" },
              { value: "custom", label: "Custom prompt" }
            ]} />
            <SelectField label="Strictness" help="Strict is best for clean datasets. Balanced is best for mixed media archives. Creative is best for exploratory research." value={promptInput.strictness || "balanced"} onChange={(value) => updatePrompt("strictness", value as PromptStrictness)} options={[
              { value: "balanced", label: "Balanced" },
              { value: "strict", label: "Strict" },
              { value: "creative", label: "Creative" }
            ]} />
            <TextField label="Audience" help="This shapes tone and expertise level." value={promptInput.audience || ""} onChange={(value) => updatePrompt("audience", value)} placeholder="research assistant" />
          </div>
          <div className="grid two section-tight">
            <TextAreaField label="Must include" help="Fields or concepts the generated prompt must require." value={promptInput.mustInclude || ""} onChange={(value) => updatePrompt("mustInclude", value)} />
            <TextAreaField label="Must avoid" help="Mistakes, topics, or behaviors the generated prompt must guard against." value={promptInput.mustAvoid || ""} onChange={(value) => updatePrompt("mustAvoid", value)} />
          </div>
          <Switch checked={Boolean(promptInput.useConnectedAI)} onChange={(checked) => updatePrompt("useConnectedAI", checked)} label="Use connected AI to refine prompt" help="If disabled, ArchiveLens generates a strong local template without spending API credits. If enabled but no key is available, it falls back to local generation." />
          <div className="button-row section-tight">
            <button className="btn" onClick={generatePrompt} disabled={promptLoading}>{promptLoading ? "Generating..." : "Generate prompt"}</button>
            <button className="btn secondary" disabled={!generatedPrompt?.prompt} onClick={() => generatedPrompt && updateOption("customRubric", generatedPrompt.prompt)}>Use as AI rubric</button>
            <button className="btn secondary" disabled={!generatedPrompt?.prompt} onClick={() => generatedPrompt && navigator.clipboard.writeText(generatedPrompt.prompt)}>Copy</button>
          </div>
          {promptError && <div className="error section-tight">{promptError}</div>}
          {generatedPrompt && (
            <div className="generated-prompt section-tight">
              <div className="generated-head">
                <span className={generatedPrompt.usedAI ? "pill good" : "pill warn"}>{generatedPrompt.usedAI ? "AI generated" : "local template"}</span>
                <small>{generatedPrompt.note}</small>
              </div>
              <pre>{generatedPrompt.prompt}</pre>
            </div>
          )}
        </div>

        <div className="card panel launch-panel">
          <SectionTitle number="05" title="Launch and export" help="Run the serverless pipeline and export the processed research database. Results remain in your browser after a completed run." />
          <div className="launch-stack">
            <ReadinessList items={runReadiness} />
            <TextAreaField label="Custom AI rubric" help="This is the prompt used by AI verification. Use Prompt Studio to generate a stronger one automatically." value={options.customRubric || ""} onChange={(value) => updateOption("customRubric", value)} />
            <div className="button-row">
              <button className="btn launch" disabled={!rows.length || loading} onClick={runPipeline}>{loading ? "Running..." : "Run pipeline"}</button>
              <button className="btn secondary" disabled={!result?.rows.length} onClick={() => result && downloadBlob("archivelens_processed.csv", unparseCsv(result.rows), "text/csv;charset=utf-8")}>CSV</button>
              <button className="btn secondary" disabled={!result?.rows.length} onClick={() => result && downloadBlob("archivelens_processed.jsonl", result.rows.map((row) => JSON.stringify(row)).join("\n"), "application/jsonl;charset=utf-8")}>JSONL</button>
              <button className="btn secondary" disabled={!result?.rows.length} onClick={() => downloadDocx()}>DOCX</button>
            </div>
          </div>
          {error && <div className="error section-tight">{error}</div>}
          {result && <div className="success section-tight">Pipeline complete in {(result.stats.elapsedMs / 1000).toFixed(1)}s. Saved {result.stats.duplicateRequestsSaved.toLocaleString()} scrape requests and {result.stats.aiCallsSaved.toLocaleString()} AI calls.</div>}
          {loading && <div className="loading-panel section-tight"><span className="spinner" /> Processing on /api/process. Results appear when the Vercel Function returns.</div>}
        </div>
      </section>

      {result && (
        <section className="section card results-card">
          <div className="results-header">
            <div>
              <div className="eyebrow">Latest run</div>
              <h2>Results console</h2>
              <p className="muted-copy">View the processed output directly in the website, filter it down, inspect individual articles, and export only the filtered subset.</p>
            </div>
            <div className="segmented">
              <button className={resultPanel === "table" ? "seg active" : "seg"} onClick={() => setResultPanel("table")}>Table</button>
              <button className={resultPanel === "reader" ? "seg active" : "seg"} onClick={() => setResultPanel("reader")}>Article viewer</button>
              <button className={resultPanel === "log" ? "seg active" : "seg"} onClick={() => setResultPanel("log")}>Log</button>
              <button className={resultPanel === "guide" ? "seg active" : "seg"} onClick={() => setResultPanel("guide")}>Guide</button>
            </div>
          </div>

          <div className="grid four section-tight">
            <Metric label="Filtered rows" value={filteredStats.filteredCount.toLocaleString()} caption={`${outputRows.length.toLocaleString()} total processed`} />
            <Metric label="Mean quality" value={filteredStats.meanQuality === null ? "--" : filteredStats.meanQuality.toFixed(1)} caption="after filters" />
            <Metric label="Mean alignment" value={filteredStats.meanAlignment === null ? "--" : filteredStats.meanAlignment.toFixed(1)} caption="after filters" />
            <Metric label="US national" value={filteredStats.usNational.toLocaleString()} caption={`${filteredStats.national.toLocaleString()} national outlets`} />
          </div>

          <div className="filter-console section-tight">
            <div className="filter-head">
              <div>
                <div className="eyebrow">Filter builder</div>
                <h3>Slice the output without leaving the app</h3>
              </div>
              <button className="btn secondary" onClick={resetResultFilters}>Reset filters</button>
            </div>

            <div className="preset-row">
              <button className="seg" onClick={() => applyFilterPreset("all")}>All rows</button>
              <button className="seg" onClick={() => applyFilterPreset("high-quality")}>High quality</button>
              <button className="seg" onClick={() => applyFilterPreset("us-national")}>US national news</button>
              <button className="seg" onClick={() => applyFilterPreset("manual-review")}>Manual review</button>
              <button className="seg" onClick={() => applyFilterPreset("bot-blocked")}>Bot blocked</button>
            </div>

            <div className="grid four section-tight">
              <TextField label="Search output" help="Searches headline, URL, country, summary, reasoning, status, and recovered article text." value={search} onChange={setSearch} placeholder="climate, hurricane, Exxon, Reuters..." />
              <NumberField label="Minimum quality score" help="Only show rows with quality_score at or above this number." min={0} max={100} value={minQuality} onChange={setMinQuality} />
              <NumberField label="Minimum alignment score" help="Only show rows with summary_alignment_score at or above this number." min={0} max={100} value={minAlignment} onChange={setMinAlignment} />
              <NumberField label="Minimum word count" help="Useful for hiding tiny fragments and boilerplate pages." min={0} max={50000} value={minWords} onChange={setMinWords} />
              <SelectField label="National outlet" help="Filter by the AI-generated is_national_outlet field." value={nationalFilter} onChange={(value) => setNationalFilter(value as NationalFilter)} options={[{ value: "any", label: "Any" }, { value: "national", label: "National outlets only" }, { value: "not-national", label: "Not national / local / unknown" }]} />
              <SelectField label="Outlet country" help="Choose United States to isolate US-based news sources, or use Any for all countries." value={countryFilter} onChange={setCountryFilter} options={countryOptions} />
              <SelectField label="Recovery label" help="Filter by scraper result: full_text, partial_text, bot_blocked, auth_required, failed, and so on." value={recoveryFilter} onChange={setRecoveryFilter} options={recoveryOptions} />
              <SelectField label="AI status" help="Filter by AI verification status, such as VERIFIED_PASSED or NEEDS_MANUAL_REVIEW." value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
              <SelectField label="Sort by" help="Controls the table and article viewer order." value={sortMode} onChange={(value) => setSortMode(value as SortMode)} options={[
                { value: "quality-desc", label: "Quality score: high to low" },
                { value: "alignment-desc", label: "Alignment score: high to low" },
                { value: "words-desc", label: "Word count: high to low" },
                { value: "headline-asc", label: "Headline: A to Z" },
                { value: "country-asc", label: "Country: A to Z" }
              ]} />
              <Switch checked={onlyDuplicateGroups} onChange={setOnlyDuplicateGroups} label="Only duplicate groups" help="Show only rows that came from a duplicate-title group size of 2 or more." />
            </div>

            <div className="button-row section-tight">
              <button className="btn secondary" disabled={!filteredRows.length} onClick={() => downloadBlob("archivelens_filtered.csv", unparseCsv(filteredRows), "text/csv;charset=utf-8")}>Export filtered CSV</button>
              <button className="btn secondary" disabled={!filteredRows.length} onClick={() => downloadBlob("archivelens_filtered.jsonl", filteredRows.map((row) => JSON.stringify(row)).join("\n"), "application/jsonl;charset=utf-8")}>Export filtered JSONL</button>
              <button className="btn secondary" disabled={!filteredRows.length} onClick={() => downloadDocx(filteredRows)}>Export filtered DOCX</button>
            </div>
          </div>

          {resultPanel === "table" && (
            <>
              <div className="table-note section-tight">Showing {filteredRows.slice(0, 500).length.toLocaleString()} of {filteredRows.length.toLocaleString()} filtered rows. Use the Article viewer to read full recovered text and AI reasoning.</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Open</th>
                      {visibleColumns.map((column) => <th key={column}>{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.slice(0, 500).map((row, index) => (
                      <tr key={index}>
                        <td><button className="mini-btn" onClick={() => { setSelectedRowIndex(index); setResultPanel("reader"); }}>View</button></td>
                        {visibleColumns.map((column) => {
                          const value = row[column];
                          const isStatus = /quality_label|status/.test(column);
                          const isBoolean = column === "is_national_outlet";
                          return <td key={column}>{isStatus ? <span className={pillClass(value)}>{String(value ?? "")}</span> : isBoolean ? <span className={boolValue(value) ? "pill good" : "pill info"}>{boolValue(value) ? "yes" : "no"}</span> : compact(value, column === "executive_summary" ? 320 : 220)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {resultPanel === "reader" && (
            <ArticleViewer
              rows={filteredRows}
              selectedIndex={Math.min(selectedRowIndex, Math.max(filteredRows.length - 1, 0))}
              selectedRow={selectedRow}
              onSelect={setSelectedRowIndex}
            />
          )}

          {resultPanel === "log" && <pre className="logbox">{result.logs.slice(-180).join("\n")}</pre>}
          {resultPanel === "guide" && <GuidePanel />}
        </section>
      )}
    </main>
  );
}

function ArticleViewer({ rows, selectedIndex, selectedRow, onSelect }: { rows: RowRecord[]; selectedIndex: number; selectedRow: RowRecord | null; onSelect: (index: number) => void }) {
  if (!rows.length || !selectedRow) {
    return <div className="empty-state section-tight">No rows match the current filters. Reset filters or broaden the score thresholds.</div>;
  }

  const fullText = String(selectedRow.fetched_text ?? "").trim();
  const summary = String(selectedRow.executive_summary ?? selectedRow.deep_summary ?? "").trim();
  const reasoning = String(selectedRow.reasoning ?? selectedRow.summary_alignment_notes ?? "").trim();
  const sourceUrl = String(selectedRow.source_url_used || selectedRow.canonical_url || selectedRow.url || selectedRow.link || "");

  return (
    <div className="reader-console section-tight">
      <div className="reader-toolbar">
        <label className="field">
          <FieldLabel label="Choose article" help="This list follows the current filters and sort order. Narrow filters to make the article list easier to browse." />
          <select value={selectedIndex} onChange={(event) => onSelect(Number(event.target.value))}>
            {rows.slice(0, 1000).map((row, index) => (
              <option key={`${index}-${row.source_url_used ?? row.extracted_headline ?? "row"}`} value={index}>
                {index + 1}. {rowHeadline(row)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn secondary" disabled={!fullText} onClick={() => navigator.clipboard.writeText(fullText)}>Copy full text</button>
      </div>

      <div className="reader-title-card">
        <div className="eyebrow">Article output</div>
        <h3>{rowHeadline(selectedRow)}</h3>
        {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">{compact(sourceUrl, 160)}</a> : <span className="muted-copy">No source URL available.</span>}
      </div>

      <div className="detail-grid">
        <Detail label="Recovery" value={<span className={pillClass(selectedRow.quality_label)}>{String(selectedRow.quality_label ?? "unknown")}</span>} />
        <Detail label="AI status" value={<span className={pillClass(selectedRow.status ?? selectedRow.ai_verification_status)}>{String(selectedRow.status ?? selectedRow.ai_verification_status ?? "not analyzed")}</span>} />
        <Detail label="Quality score" value={String(selectedRow.quality_score ?? "--")} />
        <Detail label="Alignment score" value={String(selectedRow.summary_alignment_score ?? "--")} />
        <Detail label="National outlet" value={<span className={boolValue(selectedRow.is_national_outlet) ? "pill good" : "pill info"}>{boolValue(selectedRow.is_national_outlet) ? "yes" : "no"}</span>} />
        <Detail label="Outlet country" value={normalizedCountry(selectedRow.outlet_country)} />
        <Detail label="Word count" value={String(selectedRow.word_count ?? "--")} />
        <Detail label="Duplicate group" value={String(selectedRow._archivelens_dedupe_group_size ?? 1)} />
      </div>

      <div className="reader-two-column section-tight">
        <div className="reader-block">
          <h4>AI executive summary</h4>
          <p>{summary || "No AI executive summary available. Enable AI verification to populate this field."}</p>
        </div>
        <div className="reader-block">
          <h4>AI reasoning / alignment notes</h4>
          <p>{reasoning || String(selectedRow.error_message ?? "No reasoning or error message available.")}</p>
        </div>
      </div>

      <div className="reader-block section-tight">
        <h4>Recovered article text</h4>
        <pre className="article-text">{fullText || "No recovered article text available for this row."}</pre>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="card metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-caption">{caption}</div>
    </div>
  );
}

function SectionTitle({ number, title, help }: { number: string; title: string; help: string }) {
  return (
    <div className="section-title-row">
      <div>
        <div className="eyebrow">{number}</div>
        <h2>{title}</h2>
      </div>
      <InfoButton>{help}</InfoButton>
    </div>
  );
}

function FieldLabel({ label, help }: { label: string; help?: string }) {
  return (
    <span className="field-label">
      {label}
      {help ? <InfoButton>{help}</InfoButton> : null}
    </span>
  );
}

function InfoButton({ children }: { children?: ReactNode }) {
  return (
    <span className="info-wrap">
      <button className="info-button" type="button" aria-label="More information">i</button>
      <span className="info-panel">{children}</span>
    </span>
  );
}

type OptionItem = string | { value: string; label: string };

function SelectField({ label, help, value, onChange, options }: { label: string; help?: string; value: string; onChange: (value: string) => void; options: OptionItem[] }) {
  return (
    <label className="field">
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((item) => {
          const optionValue = typeof item === "string" ? item : item.value;
          const optionLabel = typeof item === "string" ? item : item.label;
          return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
        })}
      </select>
    </label>
  );
}

function NumberField({ label, help, min, max, value, onChange }: { label: string; help?: string; min: number; max: number; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <FieldLabel label={label} help={help} />
      <input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function TextField({ label, help, value, onChange, placeholder }: { label: string; help?: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="field">
      <FieldLabel label={label} help={help} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function TextAreaField({ label, help, value, onChange, placeholder }: { label: string; help?: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="field">
      <FieldLabel label={label} help={help} />
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function SecretField({ label, provider, value, onChange }: { label: string; provider: Provider; value: string; onChange: (value: string) => void }) {
  return (
    <label className={`secret-card ${provider}`}>
      <div className="secret-label">
        <span>{label}</span>
        <span className={value.trim() ? "pill good" : "pill info"}>{value.trim() ? "entered" : "blank"}</span>
      </div>
      <input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Paste key for this session" autoComplete="off" />
    </label>
  );
}

function Switch({ checked, onChange, label, help }: { checked: boolean; onChange: (checked: boolean) => void; label: string; help?: string }) {
  return (
    <label className="switch-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}{help ? <InfoButton>{help}</InfoButton> : null}</span>
    </label>
  );
}

function ReadinessList({ items }: { items: Array<{ label: string; ok: boolean; note: string }> }) {
  return (
    <div className="readiness-list">
      {items.map((item) => (
        <div className="readiness-item" key={item.label}>
          <span className={item.ok ? "step-light on" : "step-light"} />
          <div>
            <div>{item.label}</div>
            <small>{item.note}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function GuidePanel() {
  const cards = [
    ["API Vault", "Choose HUIT, OpenAI, or Gemini. Use .env mode for deployment, or manual keys for quick local testing. The Test button verifies the selected provider and model."],
    ["Prompt Studio", "Type what you want in normal language. ArchiveLens turns it into a reusable rubric, then you can insert it directly into AI verification."],
    ["Duplicate grouping", "Select a title/headline column to scrape one representative URL per normalized title. This saves time while keeping every original row in exports."],
    ["Recovery routes", "Fast mode tries live pages plus reader fallback. Balanced adds Wayback. Archive first is best for old or deleted articles."],
    ["AI verification", "The AI reads recovered visible text and checks summary alignment, page quality, outlet metadata, key entities, and executive summary."],
    ["Results filters", "Use score thresholds, country, national-outlet, recovery status, AI status, word count, and duplicate-group filters to build a focused subset directly in the website."],
    ["Speed", "The biggest speed gains are duplicate grouping, fast route, lower timeout, lower retries, AI reuse, and avoiding Wayback unless you need maximum recovery."]
  ];
  return (
    <div className="guide-grid">
      {cards.map(([title, body]) => (
        <div className="guide-card" key={title}>
          <h3>{title}</h3>
          <p>{body}</p>
        </div>
      ))}
    </div>
  );
}
