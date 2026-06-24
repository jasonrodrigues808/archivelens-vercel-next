import { NextResponse } from "next/server";
import { z } from "zod";
import { generatePromptFromInput } from "@/lib/ai";
import type { ProcessOptions, PromptGeneratorInput } from "@/types/archivelens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OptionSchema = z.object({
  urlColumn: z.string().optional().default("url"),
  titleColumn: z.string().optional().default("None"),
  summaryColumn: z.string().optional().default("None"),
  duplicateGroupColumn: z.string().optional().default("None"),
  recoveryRoute: z.enum(["balanced", "fast", "live-first", "archive-first", "live-only", "archive-only"]).optional().default("balanced"),
  performanceProfile: z.enum(["balanced", "fast", "maximum"]).optional().default("fast"),
  concurrency: z.coerce.number().optional().default(4),
  retries: z.coerce.number().optional().default(2),
  timeoutMs: z.coerce.number().optional().default(12_000),
  minChars: z.coerce.number().optional().default(300),
  respectRobots: z.boolean().optional().default(true),
  useJina: z.boolean().optional().default(true),
  useWayback: z.boolean().optional().default(false),
  authorizedCookie: z.string().optional().default(""),
  enableAI: z.boolean().optional().default(true),
  reuseDuplicateAI: z.boolean().optional().default(true),
  aiProvider: z.enum(["huit", "openai", "gemini"]).default("huit"),
  aiModel: z.string().min(1).default("gpt-4o-mini"),
  customRubric: z.string().optional().default(""),
  apiCredentialMode: z.enum(["environment", "manual"]).optional().default("environment"),
  aiApiKey: z.string().optional().default(""),
  aiBaseUrl: z.string().optional().default(""),
  huitApiKey: z.string().optional().default(""),
  openaiApiKey: z.string().optional().default(""),
  geminiApiKey: z.string().optional().default(""),
  huitBaseUrl: z.string().optional().default(""),
  openaiBaseUrl: z.string().optional().default("")
});

const InputSchema = z.object({
  userGoal: z.string().min(3, "Describe what you want the prompt to do."),
  promptKind: z.enum(["ai-rubric", "article-recovery", "summary-alignment", "dataset-methods", "custom"]).default("ai-rubric"),
  audience: z.string().optional().default("a careful research assistant"),
  strictness: z.enum(["balanced", "strict", "creative"]).optional().default("balanced"),
  mustInclude: z.string().optional().default(""),
  mustAvoid: z.string().optional().default(""),
  useConnectedAI: z.boolean().optional().default(true)
});

const PayloadSchema = z.object({
  input: InputSchema,
  options: OptionSchema
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = PayloadSchema.parse(await request.json());
    const result = await generatePromptFromInput(payload.input as PromptGeneratorInput, payload.options as ProcessOptions);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
