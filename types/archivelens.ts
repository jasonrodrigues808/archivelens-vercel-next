export type Provider = "huit" | "openai" | "gemini";
export type ApiCredentialMode = "environment" | "manual";
export type RecoveryRoute = "balanced" | "fast" | "live-first" | "archive-first" | "live-only" | "archive-only";
export type PerformanceProfile = "balanced" | "fast" | "maximum";
export type PromptKind = "ai-rubric" | "article-recovery" | "summary-alignment" | "dataset-methods" | "custom";
export type PromptStrictness = "balanced" | "strict" | "creative";

export type PromptGeneratorInput = {
  userGoal: string;
  promptKind: PromptKind;
  audience?: string;
  strictness?: PromptStrictness;
  mustInclude?: string;
  mustAvoid?: string;
  useConnectedAI?: boolean;
};

export type PromptGeneratorResult = {
  prompt: string;
  usedAI: boolean;
  provider: Provider;
  model: string;
  note: string;
};

export type RowRecord = Record<string, string | number | boolean | null | undefined | string[]>;

export type ProcessOptions = {
  urlColumn: string;
  titleColumn?: string;
  summaryColumn?: string;
  duplicateGroupColumn?: string;
  recoveryRoute: RecoveryRoute;
  performanceProfile: PerformanceProfile;
  concurrency: number;
  retries: number;
  timeoutMs: number;
  minChars: number;
  respectRobots: boolean;
  useJina: boolean;
  useWayback: boolean;
  authorizedCookie?: string;
  enableAI: boolean;
  reuseDuplicateAI: boolean;
  aiProvider: Provider;
  aiModel: string;
  customRubric?: string;
  apiCredentialMode?: ApiCredentialMode;
  aiApiKey?: string;
  aiBaseUrl?: string;
  huitApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  huitBaseUrl?: string;
  openaiBaseUrl?: string;
};

export type ExtractionAttempt = {
  route: string;
  sourceUrl: string;
  statusCode: string | number;
  chars: number;
  words: number;
  paragraphs: number;
  score: number;
  label: string;
  error?: string;
  title?: string;
  author?: string;
  boilerplateRatio?: number;
  duplicateParagraphRatio?: number;
  selected?: boolean;
};

export type DomainHealth = {
  domain: string;
  rows: number;
  fullText: number;
  partial: number;
  failed: number;
  botBlocked: number;
  authRequired: number;
  rateLimited: number;
  robotsDisallowed: number;
  averageExtractionScore: number;
  averageQualityScore: number;
  averageAlignmentScore: number;
};

export type ScrapeResult = RowRecord & {
  quality_label: string;
  error_message: string;
  fetched_text: string;
  extracted_headline: string;
  extracted_author: string;
  extracted_date: string;
  extracted_site_name: string;
  canonical_url: string;
  recovery_route: string;
  http_status: string | number;
  source_url_used: string;
  word_count: number;
  char_count: number;
  paragraph_count: number;
  extraction_score: number;
  robots_note: string;
  elapsed_s: number;
  candidate_count: number;
  winning_candidate_route: string;
  candidate_routes: string;
  extraction_confidence_label: string;
  boilerplate_ratio: number;
  duplicate_paragraph_ratio: number;
  extraction_trace_json: string;
  _archivelens_dedupe_key?: string;
  _archivelens_dedupe_group_size?: number;
  _archivelens_dedupe_representative_row?: number;
  _archivelens_representative_url?: string;
  _archivelens_scraped_once_for_group?: boolean;
};

export type AiEvidence = {
  claim: string;
  quote: string;
  relevance: string;
};

export type AiResult = {
  quality_score: number;
  summary_alignment_score: number;
  extraction_completeness_score: number;
  article_relevance_score: number;
  source_reliability_score: number;
  national_outlet_confidence: number;
  outlet_country_confidence: number;
  status: string;
  ai_verification_status: string;
  headline: string;
  author: string;
  is_national_outlet: boolean;
  outlet_country: string;
  executive_summary: string;
  deep_summary: string;
  reasoning: string;
  summary_alignment_notes: string;
  key_entities: string[];
  key_quotes: string[];
  evidence: AiEvidence[];
  evidence_json: string;
  evidence_count: number;
  tone_and_bias: string;
  rubric_version: string;
  model_used: string;
  provider_used: Provider;
  analyzed_at: string;
};

export type ProcessStats = {
  inputRows: number;
  representativeJobs: number;
  duplicateRequestsSaved: number;
  fullTextRows: number;
  partialRows: number;
  failedRows: number;
  botBlockedRows: number;
  authRequiredRows: number;
  aiCalls: number;
  aiCallsSaved: number;
  elapsedMs: number;
};

export type ProcessResponse = {
  runId: string;
  createdAt: string;
  rows: Array<ScrapeResult & Partial<AiResult>>;
  stats: ProcessStats;
  domainHealth: DomainHealth[];
  logs: string[];
  columns: string[];
  settingsSnapshot: Partial<ProcessOptions>;
};
