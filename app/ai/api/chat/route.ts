// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  debug?: boolean;
};

type Candidate = {
  id: number;
  name: string | null;
  url: string | null;

  // prix HT en base (product) + fallback min variant
  price: number | null;
  min_variant_price?: number | null;

  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url?: string | null;
  payload?: any;

  channels: number | null;
  poe: boolean;
  ip: boolean;
  kind: "recorder" | "camera" | "other";
  brandLabel: string | null;
};

type Need = {
  wantsRecorder: boolean;
  wantsCameras:
