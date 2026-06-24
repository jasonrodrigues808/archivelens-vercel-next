import { NextResponse } from "next/server";
import { z } from "zod";
import { testAiConnection } from "@/lib/ai";
import type { ProcessOptions } from "@/types/archivelens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OptionsSchema = z.object({
  urlColumn: z.string().optional().default("url"),
  titleColumn: z.string().optional().default("None"),
  summaryColumn: z.string().optional().default("None"),
  duplicateGroupColumn: z.string().optional().default("None"),
  recoveryRoute: z.enum(["balanced", "fast", "live-first", "archive-first", "live-only", "archive-only"]).optional().default("balanced"),
  performanceProfile: z.enum(["balanced", "fast", "maximum"]).optional().default("balanced"),
  concurrency: z.coerce.number().int().min(1).max(12).optional().default(4),
  retries: z.coerce.number().int().min(1).max(8).optional().default(2),
  timeoutMs: z.coerce.number().int().min(3_000).max(60_000).optional().default(12_000),
  minChars: z.coerce.number().int().min(120).max(5_000).optional().default(300),
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

const PayloadSchema = z.object({ options: OptionsSchema });

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = PayloadSchema.parse(await request.json());
    const result = await testAiConnection(payload.options as ProcessOptions);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 400 });
  }
}
