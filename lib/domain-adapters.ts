import * as cheerio from "cheerio";

export type DomainAdapterCandidate = {
  route: string;
  text: string;
  title?: string;
  author?: string;
};

type Adapter = {
  domains: RegExp[];
  selectors: string[];
  titleSelectors?: string[];
  authorSelectors?: string[];
};

const ADAPTERS: Adapter[] = [
  {
    domains: [/apnews\.com$/i],
    selectors: ["div.RichTextStoryBody", "div[data-key='story-body']", "article", "main"],
    titleSelectors: ["h1", "meta[property='og:title']"],
    authorSelectors: ["span.Page-authors", "meta[name='author']"]
  },
  {
    domains: [/reuters\.com$/i],
    selectors: ["div.article-body__content__17Yit", "div[data-testid='paragraph']", "article", "main"],
    titleSelectors: ["h1", "meta[property='og:title']"],
    authorSelectors: ["a[data-testid='AuthorName']", "meta[name='author']"]
  },
  {
    domains: [/theguardian\.com$/i],
    selectors: ["div#maincontent", "article", "main"],
    titleSelectors: ["h1", "meta[property='og:title']"],
    authorSelectors: ["a[rel='author']", "meta[name='author']"]
  },
  {
    domains: [/nytimes\.com$/i],
    selectors: ["section[name='articleBody']", "article", "main"],
    titleSelectors: ["h1", "meta[property='og:title']"],
    authorSelectors: ["span[itemprop='name']", "meta[name='author']"]
  },
  {
    domains: [/washingtonpost\.com$/i],
    selectors: ["article", "main", "div[data-qa='article-body']"],
    titleSelectors: ["h1", "meta[property='og:title']"],
    authorSelectors: ["a[rel='author']", "meta[name='author']"]
  }
];

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function textFromNode($: cheerio.CheerioAPI, node: any): string {
  const blocks: string[] = [];
  $(node).find("h1,h2,h3,p,li,blockquote").each((_, child) => {
    const text = clean($(child).text());
    if (text.split(/\s+/).length < 3) return;
    const tag = child.tagName.toLowerCase();
    if (tag === "h1") blocks.push(`# ${text}`);
    else if (tag === "h2") blocks.push(`## ${text}`);
    else if (tag === "h3") blocks.push(`### ${text}`);
    else if (tag === "li") blocks.push(`- ${text}`);
    else if (tag === "blockquote") blocks.push(`> ${text}`);
    else blocks.push(text);
  });
  return blocks.join("\n\n");
}

function extractSelectorText($: cheerio.CheerioAPI, selectors: string[] | undefined): string {
  if (!selectors) return "";
  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) continue;
    const meta = element.attr("content");
    const value = clean(meta || element.text());
    if (value) return value;
  }
  return "";
}

export function domainAdapterCandidates(html: string, sourceUrl: string): DomainAdapterCandidate[] {
  let hostname = "";
  try {
    hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return [];
  }

  const adapter = ADAPTERS.find((candidate) => candidate.domains.some((pattern) => pattern.test(hostname)));
  if (!adapter) return [];

  const $ = cheerio.load(html);
  const title = extractSelectorText($, adapter.titleSelectors);
  const author = extractSelectorText($, adapter.authorSelectors);
  const out: DomainAdapterCandidate[] = [];

  for (const selector of adapter.selectors) {
    $(selector).each((_, node) => {
      const text = textFromNode($, node);
      if (text.length > 250) out.push({ route: `domain_adapter:${hostname}:${selector}`, text, title, author });
    });
  }

  return out.slice(0, 5);
}
