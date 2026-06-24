# ArchiveLens Vercel Console

ArchiveLens is a Next.js/Vercel app for duplicate-aware article recovery, AI verification, prompt generation, and CSV/JSONL/DOCX export.

## What is new in this version

- API Vault inside the interface for HUIT/OpenAI/Gemini
- Provider-specific key fields for temporary/manual API connections
- Environment-variable mode for Vercel deployment
- API connection test button
- Prompt Studio that turns your plain-language goal into a strong AI rubric or extraction prompt
- Info buttons beside major controls so you know what each setting does
- More polished dark command-center interface
- Duplicate title grouping before scraping
- Duplicate-aware AI reuse
- In-site results console with searchable/filterable output table
- Score threshold filters for quality and summary alignment
- National-outlet and outlet-country filters, including US national news
- Article viewer for full recovered text, AI summary, reasoning, URL, and metadata
- Export filtered-only CSV, JSONL, and DOCX

## Install on your computer

Install Node.js, then install the project packages:

```bash
cd archivelens_vercel_next
npm install
```

The project dependencies are listed in `package.json`. The main runtime packages are:

```bash
npm install next react react-dom papaparse cheerio robots-parser p-limit openai @google/generative-ai docx zod
npm install -D typescript @types/node @types/react @types/react-dom @types/papaparse
```

## Local environment variables

Create `.env.local`:

```bash
cp .env.example .env.local
```

Then add any keys you want to use:

```bash
HUIT_OPENAI_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
HUIT_OPENAI_BASE_URL=https://go.apis.huit.harvard.edu/ais-openai-direct-limited-schools/v1
ARCHIVELENS_CONTACT_EMAIL=your-email@example.edu
```

You can also skip `.env.local` and use the in-app API Vault in manual/session-key mode.

## Run locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## API Vault workflow

Inside the app:

1. Open the API Vault panel.
2. Choose `Use .env / Vercel` or `Paste keys here`.
3. Pick HUIT, OpenAI, or Gemini.
4. Choose a model.
5. Click the test button.
6. Enable AI verification when ready.

Manual keys are sent only with the current request. Environment mode uses `.env.local` locally and Vercel project environment variables after deployment.

## Prompt Studio workflow

1. Type what you want the AI to evaluate.
2. Pick a prompt type, strictness, and audience.
3. Add anything the prompt must include or avoid.
4. Click `Generate prompt`.
5. Click `Use as AI rubric` to insert it into the verification pipeline.

Prompt Studio can use your connected AI provider. If no API key is available, it falls back to a local template generator.


## Results console workflow

After running the pipeline, open the Results Console inside the website. It includes:

- Search across headline, URL, country, status, AI reasoning, executive summary, and recovered text
- Minimum `quality_score` filter
- Minimum `summary_alignment_score` filter
- Minimum word-count filter
- National-outlet filter: any, national only, or non-national/local/unknown
- Outlet-country filter, including `United States`
- Recovery-label filter such as `full_text`, `partial_text`, `bot_blocked`, or `auth_required`
- AI-status filter such as `VERIFIED_PASSED` or `NEEDS_MANUAL_REVIEW`
- Duplicate-group-only toggle
- Sort controls for quality, alignment, word count, headline, and country

Use the `US national news` preset to combine national-outlet filtering with `United States` outlet country. These fields come from AI verification, so enable AI if you want the national/country filters to be accurate.

The Article Viewer tab lets you read the selected result inside the website, including recovered article text, AI executive summary, AI reasoning, score fields, recovery label, source URL, outlet country, and duplicate-group size.

Filtered exports are available directly inside the Results Console as filtered CSV, filtered JSONL, and filtered DOCX.

## Deploy to Vercel

```bash
npm install -g vercel
vercel login
vercel
vercel --prod
```

Add the same environment variables in the Vercel dashboard under Project Settings.

## Fast settings

For speed:

```text
Group duplicate articles before scraping: title/headline column
Recovery route: Fast: live + reader only
Performance profile: Fast duplicate-aware
Concurrency: 6-8
Retries: 2
Timeout: 12 seconds
Use public reader fallback: on
Use Wayback fallback: off
Reuse duplicate AI: on
```

For maximum recovery:

```text
Recovery route: Balanced or Archive first
Performance profile: Maximum recovery
Use public reader fallback: on
Use Wayback fallback: on
Retries: 4+
Timeout: 20+ seconds
```
