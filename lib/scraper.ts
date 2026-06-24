import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import type { ProcessOptions, RowRecord, ScrapeResult } from "@/types/archivelens";

const DEFAULT_USER_AGENT = "ArchiveLensResearchBot/3.0 (+https://example.edu/archivelens; research-use)";

const JUNK_PHRASES = [
  "verify you are human",
  "are you a robot",
  "cloudflare",
  "pardon our interruption",
  "enable javascript",
  "javascript is required",
  "please enable cookies",
  "cookie preferences",
  "privacy policy",
  "terms of service",
  "newsletter sign up",
  "subscribe to our newsletter",
  "advertisement"
];

const AUTH_PHRASES = [
  "subscribe to continue",
  "subscription required",
  "log in to continue",
  "log in to keep reading",
  "sign in to continue",
  "already a subscriber",
  "members-only",
  "this content is for subscribers",
  "you have reached your article limit",
  "metered paywall"
];

const BOT_BLOCK_PHRASES = [
  "bot not allowed",
  "bots are not allowed",
  "automated access is not allowed",
  "automated traffic",
  "unusual traffic",
  "request blocked",
  "access denied",
  "forbidden for bots",
  "your request has been blocked",
  "temporarily blocked"
];

const BOILERPLATE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "nav",
  "footer",
  "header",
  "aside",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  ".ad",
  ".ads",
  ".advertisement",
  ".newsletter",
  ".share",
  ".social",
  ".comments",
  ".related",
  ".recirc",
  ".breadcrumb",
  ".modal",
  ".popup",
  ".cookie"
];

type Candidate = {
  text: string;
  route: string;
  sourceUrl: string;
  statusCode: number | string;
  metadata: ArticleMetadata;
  score: number;
  error: string;
};

type ArticleMetadata = {
  title: string;
  author: string;
  date: string;
  siteName: string;
  canonicalUrl: string;
};

type FetchOutcome = {
  ok: boolean;
  status: number;
  url: string;
  text: string;
  error: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufdd0-\ufdef\ufffe\uffff]/g, "")
    .replace(/\u00a0/g, " ");
}

function collapseWhitespace(value: unknown): string {
  return sanitizeText(value).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUrl(input: string): string {
  let cleaned = String(input ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("//")) cleaned = `https:${cleaned}`;
  if (!/^https?:\/\//i.test(cleaned) && cleaned.includes(".") && !/\s/.test(cleaned)) cleaned = `https://${cleaned}`;
  try {
    const parsed = new URL(cleaned);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function requestHeaders(options: ProcessOptions): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache"
  };

  const contact = process.env.ARCHIVELENS_CONTACT_EMAIL;
  if (contact) headers.From = contact;

  if (options.authorizedCookie?.trim()) {
    headers.Cookie = options.authorizedCookie.trim().replace(/[\r\n]/g, "");
  }

  return headers;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function fetchWithRetries(url: string, options: ProcessOptions, route: string): Promise<FetchOutcome> {
  let lastError = "";
  let lastStatus = 0;
  const attempts = Math.max(1, options.retries);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: requestHeaders(options),
        redirect: "follow",
        signal: AbortSignal.timeout(Math.max(2_000, options.timeoutMs))
      });

      lastStatus = response.status;

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const backoff = retryAfter ?? Math.min(45_000, 1_000 * 2 ** attempt + Math.random() * 1_500);
        lastError = `HTTP 429 rate limited on ${route}; respected backoff ${Math.round(backoff / 1000)}s.`;
        if (attempt < attempts - 1) await sleep(backoff);
        continue;
      }

      if ([401, 403].includes(response.status)) {
        const body = await response.text().catch(() => "");
        return { ok: false, status: response.status, url: response.url || url, text: body, error: "Authorization or access restriction returned by server." };
      }

      if (response.status >= 500 && response.status < 600 && attempt < attempts - 1) {
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt + Math.random() * 1_200));
        continue;
      }

      const text = await response.text();
      return { ok: response.ok, status: response.status, url: response.url || url, text, error: response.ok ? "" : `HTTP ${response.status}` };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts - 1) await sleep(Math.min(25_000, 1_000 * 2 ** attempt + Math.random() * 1_000));
    }
  }

  return { ok: false, status: lastStatus, url, text: "", error: lastError || `Fetch failed for ${url}` };
}

async function robotsAllowed(url: string, options: ProcessOptions): Promise<{ allowed: boolean; note: string }> {
  if (!options.respectRobots) return { allowed: true, note: "robots.txt check disabled by user setting." };

  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const response = await fetch(robotsUrl, {
      headers: requestHeaders(options),
      signal: AbortSignal.timeout(Math.min(options.timeoutMs, 8_000))
    });

    if (!response.ok) return { allowed: true, note: "robots.txt unavailable; proceeded conservatively." };

    const robotsText = await response.text();
    const parser = robotsParser(robotsUrl, robotsText);
    const allowed = parser.isAllowed(url, DEFAULT_USER_AGENT);
    return allowed === false
      ? { allowed: false, note: "Blocked by robots.txt for ArchiveLensResearchBot." }
      : { allowed: true, note: "robots.txt allowed." };
  } catch {
    return { allowed: true, note: "robots.txt check failed; proceeded conservatively." };
  }
}

function contentMetrics(text: string): { chars: number; words: number; paragraphs: number; sentences: number; junkHits: number; authHits: number; botHits: number } {
  const clean = collapseWhitespace(text);
  const lower = clean.toLowerCase();
  return {
    chars: clean.length,
    words: (clean.match(/\b\w+[\w'-]*\b/g) ?? []).length,
    paragraphs: clean.split(/\n\s*\n/).filter((p) => p.split(/\s+/).length >= 8).length,
    sentences: (clean.match(/[.!?](?:\s|$)/g) ?? []).length,
    junkHits: JUNK_PHRASES.filter((phrase) => lower.includes(phrase)).length,
    authHits: AUTH_PHRASES.filter((phrase) => lower.includes(phrase)).length,
    botHits: BOT_BLOCK_PHRASES.filter((phrase) => lower.includes(phrase)).length
  };
}

function scoreTextQuality(text: string, minChars: number): number {
  const m = contentMetrics(text);
  if (!m.chars) return 0;

  let score = 0;
  score += Math.min(45, m.chars / 120);
  score += Math.min(25, m.words / 35);
  score += Math.min(20, m.paragraphs * 2.5);
  score += Math.min(10, m.sentences / 4);

  if (m.chars < minChars) score -= 35;
  if (m.paragraphs < 2) score -= 15;
  if (m.authHits) score -= 45;
  if (m.botHits) score -= 60;
  if (m.junkHits) score -= Math.min(30, m.junkHits * 8);

  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

function classifyQuality(text: string, minChars: number, statusCode: number | string): { label: string; error: string } {
  const metrics = contentMetrics(text);

  if (statusCode === 429) return { label: "rate_limited", error: "HTTP 429 received. Reduce concurrency or retry later." };
  if ([401, 403].includes(Number(statusCode))) return { label: "auth_required", error: "Server requires authorization, login, or access permission." };
  if (metrics.botHits > 0) return { label: "bot_blocked", error: "The recovered page says automated/bot access is blocked." };
  if (metrics.authHits > 0) return { label: "auth_required", error: "Recovered page appears to be a login/subscription/access-control screen." };
  if (metrics.chars === 0) return { label: "failed", error: "No extractable text found." };
  if (metrics.chars < minChars || metrics.words < 80) return { label: "partial_text", error: "Only a short fragment was recovered." };

  const score = scoreTextQuality(text, minChars);
  if (score >= 68) return { label: "full_text", error: "" };
  if (score >= 42) return { label: "partial_text", error: "Recovered text may be incomplete or noisy." };
  return { label: "low_confidence", error: "Recovered text quality is low; verify manually." };
}

function metaContent($: cheerio.CheerioAPI, ...names: string[]): string {
  for (const name of names) {
    const value = $(`meta[property="${name}"], meta[name="${name}"]`).first().attr("content");
    if (value) return collapseWhitespace(value);
  }
  return "";
}

function extractMetadata($: cheerio.CheerioAPI): ArticleMetadata {
  const title = metaContent($, "og:title", "twitter:title") || collapseWhitespace($("title").first().text()) || collapseWhitespace($("h1").first().text());
  const author = metaContent($, "author", "article:author", "parsely-author", "sailthru.author");
  const date = metaContent($, "article:published_time", "date", "pubdate", "publish-date", "parsely-pub-date");
  const siteName = metaContent($, "og:site_name", "application-name");
  const canonicalUrl = $("link[rel='canonical']").first().attr("href") ?? "";

  return {
    title: sanitizeText(title),
    author: sanitizeText(author),
    date: sanitizeText(date),
    siteName: sanitizeText(siteName),
    canonicalUrl: sanitizeText(canonicalUrl)
  };
}

function authorToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return collapseWhitespace(value);
  if (Array.isArray(value)) return value.map(authorToText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return collapseWhitespace(record.name ?? record.url ?? "");
  }
  return "";
}

function walkJson(value: unknown, onString: (text: string, keyHint: string) => void, keyHint = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, onString, keyHint));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkJson(child, onString, key.toLowerCase());
    }
    return;
  }
  if (typeof value === "string") onString(value, keyHint);
}

function extractJsonLd($: cheerio.CheerioAPI): { texts: string[]; metadata: Partial<ArticleMetadata> } {
  const texts: string[] = [];
  const metadata: Partial<ArticleMetadata> = {};

  $("script[type*='ld+json']").each((_, element) => {
    const raw = $(element).html() ?? "";
    try {
      const parsed = JSON.parse(raw.trim());
      const objects = Array.isArray(parsed) ? parsed : [parsed];
      const stack = [...objects];
      while (stack.length) {
        const obj = stack.pop();
        if (!obj || typeof obj !== "object") continue;
        const record = obj as Record<string, unknown>;
        Object.values(record).forEach((child) => {
          if (Array.isArray(child) || (child && typeof child === "object")) stack.push(child);
        });
        const rawType = record["@type"];
        const types = Array.isArray(rawType) ? rawType.map(String) : [String(rawType ?? "")];
        const isArticle = types.some((type) => /article|blogposting|report/i.test(type)) || Boolean(record.articleBody);
        if (!isArticle) continue;
        if (typeof record.articleBody === "string" && record.articleBody.length > 120) texts.push(collapseWhitespace(record.articleBody));
        if (!metadata.title && typeof record.headline === "string") metadata.title = collapseWhitespace(record.headline);
        if (!metadata.author && record.author) metadata.author = authorToText(record.author);
        if (!metadata.date && (record.datePublished || record.dateModified)) metadata.date = collapseWhitespace(record.datePublished ?? record.dateModified);
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return { texts: dedupeBlocks(texts), metadata };
}

function extractStatePayloadText($: cheerio.CheerioAPI): string[] {
  const candidates: string[] = [];
  const articleKeys = new Set(["articlebody", "body", "content", "contenttext", "text", "storybody", "maintext", "description", "dek", "summary"]);

  $("script").each((_, element) => {
    const raw = $(element).html() ?? "";
    const id = String($(element).attr("id") ?? "").toLowerCase();
    const type = String($(element).attr("type") ?? "").toLowerCase();
    const header = raw.slice(0, 900).toLowerCase();
    const likelyState =
      id === "__next_data__" ||
      id.includes("nuxt") ||
      type.includes("application/json") ||
      header.includes("__initial_state__") ||
      header.includes("__preloaded_state__") ||
      raw.toLowerCase().includes("articlebody");

    if (!likelyState || raw.length > 2_500_000) return;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      const match = raw.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          parsed = null;
        }
      }
    }

    if (parsed) {
      walkJson(parsed, (value, keyHint) => {
        const clean = collapseWhitespace(value.replace(/\\n/g, "\n").replace(/\\t/g, " "));
        const words = clean.split(/\s+/).length;
        const punctuation = (clean.match(/[.!?]/g) ?? []).length;
        if (clean.length > 220 && words >= 45 && punctuation >= 2 && (articleKeys.has(keyHint) || words >= 80)) {
          candidates.push(clean);
        }
      });
    } else {
      const matches = raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g);
      for (const match of matches) {
        const clean = collapseWhitespace(match[1].replace(/\\n/g, "\n").replace(/\\u2019/g, "'").replace(/\\u201c/g, '"').replace(/\\u201d/g, '"'));
        if (clean.length > 260 && clean.split(/\s+/).length > 50) candidates.push(clean);
      }
    }
  });

  return dedupeBlocks(candidates).sort((a, b) => scoreTextQuality(b, 300) - scoreTextQuality(a, 300)).slice(0, 8);
}

function dedupeBlocks(blocks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const clean = collapseWhitespace(block);
    if (!clean) continue;
    const fingerprint = clean.toLowerCase().replace(/\W+/g, "").slice(0, 220);
    if (fingerprint.length < 20 || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(clean);
  }
  return out;
}

function removeBoilerplate($: cheerio.CheerioAPI): void {
  for (const selector of BOILERPLATE_SELECTORS) $(selector).remove();
}

function nodeToMarkdown($: cheerio.CheerioAPI, node: any): string {
  const blocks: string[] = [];
  $(node)
    .find("h1,h2,h3,h4,p,li,blockquote")
    .each((_, element) => {
      const text = collapseWhitespace($(element).text());
      if (!text || text.split(/\s+/).length < 3) return;
      const tag = element.tagName.toLowerCase();
      if (tag === "h1") blocks.push(`# ${text}`);
      else if (tag === "h2") blocks.push(`## ${text}`);
      else if (tag === "h3") blocks.push(`### ${text}`);
      else if (tag === "h4") blocks.push(`#### ${text}`);
      else if (tag === "li") blocks.push(`- ${text}`);
      else if (tag === "blockquote") blocks.push(`> ${text}`);
      else blocks.push(text);
    });
  return dedupeBlocks(blocks).join("\n\n");
}

function linkDensity($: cheerio.CheerioAPI, node: any): number {
  const totalTextLength = collapseWhitespace($(node).text()).length;
  if (!totalTextLength) return 1;
  let linkTextLength = 0;
  $(node)
    .find("a")
    .each((_, anchor) => {
      linkTextLength += collapseWhitespace($(anchor).text()).length;
    });
  return Math.min(1, linkTextLength / totalTextLength);
}

function domCandidates($: cheerio.CheerioAPI, minChars: number): Array<{ text: string; route: string; score: number }> {
  const selectors = [
    "article",
    "main",
    "[role='main']",
    "[itemprop='articleBody']",
    "[data-testid*='article']",
    "[class*='article']",
    "[class*='story']",
    "[class*='post-content']",
    "[class*='entry-content']",
    "[class*='body']"
  ];

  const nodes: any[] = [];
  const seen = new Set<any>();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      if (!seen.has(element)) {
        seen.add(element);
        nodes.push(element);
      }
    });
  }

  if (!nodes.length && $("body").get(0)) nodes.push($("body").get(0)!);

  return nodes
    .map((node) => {
      const text = nodeToMarkdown($, node);
      const className = String($(node).attr("class") ?? "").toLowerCase();
      const id = String($(node).attr("id") ?? "").toLowerCase();
      let score = scoreTextQuality(text, minChars);
      if (/(article|story|content|body|post|entry)/i.test(`${className} ${id}`)) score += 8;
      score -= linkDensity($, node) * 30;
      return { text, route: "dom", score };
    })
    .filter((item) => item.text)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function extractSemanticContent(html: string, sourceUrl: string, minChars: number): Candidate {
  const $ = cheerio.load(html);
  const baseMetadata = extractMetadata($);
  const candidates: Array<{ text: string; route: string; score: number; metadata?: Partial<ArticleMetadata> }> = [];

  const jsonLd = extractJsonLd($);
  for (const text of jsonLd.texts) candidates.push({ text, route: "json_ld", score: scoreTextQuality(text, minChars), metadata: jsonLd.metadata });

  const stateTexts = extractStatePayloadText($);
  if (stateTexts.length) {
    const joined = stateTexts.slice(0, 4).join("\n\n");
    candidates.push({ text: joined, route: "state_payload", score: scoreTextQuality(joined, minChars) + 4 });
  }

  removeBoilerplate($);
  candidates.push(...domCandidates($, minChars));

  if (!candidates.length) {
    const fallback = collapseWhitespace($("body").text() || $.text());
    candidates.push({ text: fallback, route: "fallback_text", score: scoreTextQuality(fallback, minChars) });
  }

  const best = candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  const metadata = { ...baseMetadata, ...(best.metadata ?? {}) };

  return {
    text: collapseWhitespace(best.text),
    route: best.route,
    sourceUrl,
    statusCode: "",
    metadata,
    score: scoreTextQuality(best.text, minChars),
    error: ""
  };
}

async function executeLive(url: string, options: ProcessOptions): Promise<Candidate> {
  const fetched = await fetchWithRetries(url, options, "live");
  if (!fetched.text) {
    return { text: "", route: "live", sourceUrl: fetched.url, statusCode: fetched.status, metadata: emptyMetadata(), score: 0, error: fetched.error };
  }
  const candidate = extractSemanticContent(fetched.text, fetched.url, options.minChars);
  return { ...candidate, route: `live:${candidate.route}`, statusCode: fetched.status, error: fetched.error };
}

async function executeJina(url: string, options: ProcessOptions): Promise<Candidate> {
  const readerUrl = `https://r.jina.ai/${url}`;
  const fetched = await fetchWithRetries(readerUrl, { ...options, authorizedCookie: "" }, "jina_reader");
  if (!fetched.text) {
    return { text: "", route: "jina_reader", sourceUrl: readerUrl, statusCode: fetched.status, metadata: emptyMetadata(), score: 0, error: fetched.error };
  }

  let text = fetched.text;
  const contentTypeJson = /^\s*\{/.test(text);
  if (contentTypeJson) {
    try {
      const data = JSON.parse(text) as { data?: { content?: string }; content?: string };
      text = data.data?.content ?? data.content ?? text;
    } catch {
      // Keep raw text.
    }
  }

  text = collapseWhitespace(text);
  return {
    text,
    route: "jina_reader",
    sourceUrl: readerUrl,
    statusCode: fetched.status,
    metadata: emptyMetadata(),
    score: scoreTextQuality(text, options.minChars),
    error: fetched.error
  };
}

async function executeWayback(url: string, options: ProcessOptions): Promise<Candidate> {
  const cdxParams = new URLSearchParams({
    url,
    output: "json",
    collapse: "digest",
    fl: "timestamp,original,statuscode,mimetype,digest",
    limit: "8"
  });
  cdxParams.append("filter", "statuscode:200");
  cdxParams.append("filter", "mimetype:text/html");

  const cdxUrl = `https://web.archive.org/cdx/search/cdx?${cdxParams.toString()}`;
  const fetched = await fetchWithRetries(cdxUrl, { ...options, authorizedCookie: "" }, "wayback_cdx");
  if (!fetched.ok || !fetched.text) {
    return { text: "", route: "wayback", sourceUrl: cdxUrl, statusCode: fetched.status, metadata: emptyMetadata(), score: 0, error: fetched.error || "No Wayback CDX response." };
  }

  let rows: string[][] = [];
  try {
    rows = JSON.parse(fetched.text) as string[][];
  } catch {
    return { text: "", route: "wayback", sourceUrl: cdxUrl, statusCode: fetched.status, metadata: emptyMetadata(), score: 0, error: "Wayback CDX parse failed." };
  }

  if (!Array.isArray(rows) || rows.length <= 1) {
    return { text: "", route: "wayback", sourceUrl: cdxUrl, statusCode: 200, metadata: emptyMetadata(), score: 0, error: "No public Wayback HTML snapshots found." };
  }

  let best: Candidate = { text: "", route: "wayback", sourceUrl: cdxUrl, statusCode: 200, metadata: emptyMetadata(), score: 0, error: "No usable Wayback text found." };

  const snapshotRows = rows.slice(1).reverse();
  for (const row of snapshotRows) {
    const [timestamp, original] = row;
    if (!timestamp || !original) continue;
    const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
    const snap = await fetchWithRetries(snapshotUrl, { ...options, authorizedCookie: "" }, "wayback_snapshot");
    if (!snap.text) continue;
    const candidate = extractSemanticContent(snap.text, snapshotUrl, options.minChars);
    const scored = { ...candidate, route: `wayback:${candidate.route}`, statusCode: snap.status, error: snap.error };
    if (scored.score > best.score) best = scored;
    if (scored.score >= 68) break;
  }

  return best;
}

function emptyMetadata(): ArticleMetadata {
  return { title: "", author: "", date: "", siteName: "", canonicalUrl: "" };
}

function routeOrder(options: ProcessOptions): string[] {
  const route = options.recoveryRoute;
  let order: string[];

  if (route === "archive-only") order = ["wayback"];
  else if (route === "live-only") order = ["live"];
  else if (route === "fast") order = ["live", "jina"];
  else if (route === "archive-first") order = ["wayback", "live", "jina"];
  else if (route === "live-first") order = ["live", "jina", "wayback"];
  else order = ["live", "jina", "wayback"];

  if (!options.useJina) order = order.filter((item) => item !== "jina");
  if (!options.useWayback) order = order.filter((item) => item !== "wayback");

  return order;
}

export function tunePerformanceOptions(options: ProcessOptions): ProcessOptions {
  if (options.performanceProfile === "fast") {
    return {
      ...options,
      recoveryRoute: options.recoveryRoute === "balanced" ? "fast" : options.recoveryRoute,
      retries: Math.min(options.retries, 2),
      timeoutMs: Math.min(options.timeoutMs, 12_000),
      useWayback: options.recoveryRoute.includes("archive") ? options.useWayback : false
    };
  }

  if (options.performanceProfile === "maximum") {
    return {
      ...options,
      retries: Math.max(options.retries, 4),
      timeoutMs: Math.max(options.timeoutMs, 20_000),
      useJina: true,
      useWayback: true
    };
  }

  return options;
}

export async function processSingleUrl(rawUrl: string, row: RowRecord, options: ProcessOptions): Promise<ScrapeResult> {
  const started = Date.now();
  const url = normalizeUrl(rawUrl);

  if (!url) {
    return baseResult(row, {
      quality_label: "url_only",
      error_message: "Invalid or missing URL.",
      elapsed_s: 0
    });
  }

  const robots = await robotsAllowed(url, options);
  if (!robots.allowed) {
    return baseResult(row, {
      quality_label: "robots_disallowed",
      error_message: robots.note,
      source_url_used: url,
      recovery_route: "robots",
      robots_note: robots.note,
      elapsed_s: (Date.now() - started) / 1000
    });
  }

  const candidates: Candidate[] = [];
  const errors: string[] = [];

  for (const route of routeOrder(options)) {
    let candidate: Candidate;
    if (route === "live") candidate = await executeLive(url, options);
    else if (route === "jina") candidate = await executeJina(url, options);
    else candidate = await executeWayback(url, options);

    candidates.push(candidate);
    if (candidate.error) errors.push(`${route}: ${candidate.error}`);

    const quality = classifyQuality(candidate.text, options.minChars, candidate.statusCode);
    if (quality.label === "full_text") break;
  }

  const best = candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0] ?? {
    text: "",
    route: "none",
    sourceUrl: url,
    statusCode: "",
    metadata: emptyMetadata(),
    score: 0,
    error: "No extraction route produced a candidate."
  };

  const finalText = collapseWhitespace(best.text);
  const quality = classifyQuality(finalText, options.minChars, best.statusCode);
  const metrics = contentMetrics(finalText);

  return baseResult(row, {
    quality_label: quality.label,
    error_message: quality.error || errors.join("; ").slice(0, 500),
    fetched_text: finalText,
    extracted_headline: best.metadata.title,
    extracted_author: best.metadata.author,
    extracted_date: best.metadata.date,
    extracted_site_name: best.metadata.siteName,
    canonical_url: best.metadata.canonicalUrl,
    recovery_route: best.route,
    http_status: best.statusCode,
    source_url_used: best.sourceUrl || url,
    word_count: metrics.words,
    char_count: metrics.chars,
    paragraph_count: metrics.paragraphs,
    extraction_score: best.score,
    robots_note: robots.note,
    elapsed_s: Math.round(((Date.now() - started) / 1000) * 100) / 100
  });
}

function baseResult(row: RowRecord, patch: Partial<ScrapeResult>): ScrapeResult {
  return {
    ...row,
    quality_label: "failed",
    error_message: "",
    fetched_text: "",
    extracted_headline: "",
    extracted_author: "",
    extracted_date: "",
    extracted_site_name: "",
    canonical_url: "",
    recovery_route: "none",
    http_status: "",
    source_url_used: "",
    word_count: 0,
    char_count: 0,
    paragraph_count: 0,
    extraction_score: 0,
    robots_note: "",
    elapsed_s: 0,
    ...patch
  };
}
