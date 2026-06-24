# ArchiveLens Vercel v3

ArchiveLens v3 is a Next.js/Vercel research console for duplicate-aware article recovery, extraction auditing, AI verification, filtering, review, and export.

## v3 upgrades

### Interface

- Dark command-center UI with API Vault, Prompt Studio, Launch panel, and Results Console.
- Results tabs: Table, Article Viewer, Extraction Trace, Domain Health, Review Queue, Run History, Logs, and Guide.
- Browser-persistent run history, saved filter views, prompt library, and review labels via `localStorage`.
- Manual review actions: approve, important, needs better scrape, reject, clear review.
- Filter by score thresholds, word count, national outlet, country, recovery label, AI status, duplicate groups, and manual review label.
- Export full or filtered CSV, JSONL, DOCX, plus an audit JSON package.

### Scraper

- Multi-candidate extraction engine instead of single-route extraction.
- Candidate sources include JSON-LD, Next/Nuxt/app state payloads, domain-specific adapters, Mozilla Readability, DOM scoring, Jina Reader, and Wayback snapshots.
- Extraction traces are saved per row as `extraction_trace_json`.
- New diagnostics: candidate count, winning route, candidate routes, extraction score, confidence label, boilerplate ratio, duplicate paragraph ratio.
- Domain health table grouped by hostname.
- In-memory URL cache for warm Vercel functions.
- Robots-aware public scraping, 429 backoff, authorized-cookie support, bot/auth/rate-limit labels.

### AI

- Evidence-linked AI output with `evidence_json`.
- Split scores: extraction completeness, article relevance, source reliability, summary alignment, national-outlet confidence, outlet-country confidence.
- Prompt Studio can generate rubrics and save them to a local prompt library.

## Install locally

```bash
cd ~/Downloads/archivelens_vercel_next
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required packages

The project installs these from `package.json`:

```bash
npm install next react react-dom papaparse cheerio robots-parser p-limit openai @google/generative-ai docx zod @mozilla/readability jsdom
npm install -D typescript @types/node @types/react @types/react-dom @types/papaparse @types/jsdom
```

## Environment variables

Create `.env.local` for local development:

```bash
HUIT_OPENAI_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
HUIT_OPENAI_BASE_URL=https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1
ARCHIVELENS_CONTACT_EMAIL=your-email@example.edu
```

For production, add the same variables in Vercel Project Settings → Environment Variables.

## Deploy

```bash
npm run build
vercel --prod
```

With GitHub connected to Vercel, future updates are:

```bash
git add .
git commit -m "Update ArchiveLens"
git push
```

Vercel will auto-deploy the production branch.

## Important limitations

This v3 implementation keeps run history, saved views, review labels, and prompt library in the browser with `localStorage`. That means they are fast and simple but not shared across browsers/devices.

For a true multi-user research platform, the next step is adding Vercel Postgres/Supabase for persistent projects and Vercel Queues/Workflows for durable background processing of very large CSV files.

## Safety note

ArchiveLens does not impersonate Googlebot, falsify IP headers, or bypass access controls. It can use authorized cookies you provide for content you are allowed to access, and otherwise labels bot blocks, login walls, paywalls, robots restrictions, and rate limits transparently.


## v3.1 crash-resistance patch

This build validates API base URLs before creating provider clients. If you see `The string did not match the expected pattern`, clear the HUIT/OpenAI base URL fields and use the default HUIT endpoint: `https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1`. API keys belong in key fields or Vercel environment variables, not in base URL fields.
