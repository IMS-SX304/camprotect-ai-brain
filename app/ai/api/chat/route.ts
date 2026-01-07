// app/ai/api/chat/route.ts
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { chatCompletion, embedText, CAMPROTECT_SYSTEM_PROMPT } from "../../../../lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  topK?: number;
  debug?: boolean;
};

type RagSource = {
  id: number;
  title?: string;
  url?: string;
  similarity?: number;
};

function extractSku(text: string): string | null {
  // Match refs type DS-7616NXI-I2-S, DS-7616NXI-I2/S, 52271.146.WH1, NVR4104HS-4KS3...
  const m = text.match(/[A-Z0-9]{2,}([-.\/][A-Z0-9]{1,}){1,10}/i);
  return m ? m[0].toUpperCase() : null;
}

function skuCandidates(sku: string): string[] {
  const s = sku.toUpperCase().trim();
  const c1 = s;
  const c2 = s.replace(/\//g, "-");
  const c3 = s.replace(/-/g, "/");
  // version "compacte" (au cas où stocké sans séparateurs)
  const c4 = s.replace(/[^A-Z0-9]/g, "");
  return Array.from(new Set([c1, c2, c3, c4])).filter(Boolean);
}

function normalizeUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  const trimmed = String(u).trim();
  if (!trimmed) return undefined;

  try {
    return new URL(trimmed).toString();
  } catch {
    if (trimmed.startsWith("/")) return `https://www.camprotect.fr${trimmed}`;
    return `https://www.camprotect.fr/${trimmed.replace(/^https?:\/\//, "")}`;
  }
}

function buildProductUrlFromSlug(slug?: string | null): string | undefined {
  if (!slug) return undefined;
  const s = String(slug).trim();
  if (!s) return undefined;
  return `https://www.camprotect.fr/product/${s}`;
}

function moneyToString(price: any, currency?: any): string {
  if (price === null || price === undefined) return "N/A";
  const n = typeof price === "number" ? price : Number(price);
  if (Number.isNaN(n)) return "N/A";
  const c = (currency || "EUR").toString().toUpperCase();
  return `${n} ${c}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;

    const input = (body.input || "").trim();
    if (!input) {
      return Response.json({ ok: false, error: "Missing input" }, { status: 400 });
    }

    const topK = body.topK ?? 6;
    const conversationId = body.conversationId ?? crypto.randomUUID();
    const debugMode = !!body.debug;

    const supa = supabaseAdmin();

    const debug: any = {
      input,
      extractedSku: null as string | null,
      skuCandidates: [] as string[],
      lookup: {
        exact_product_reference: null as any,
        ilike_product_reference: null as any,
        ilike_slug: null as any,
        ilike_name: null as any,
      },
      supabaseErrors: [] as string[],
    };

    // ------------------------------------------------------------
    // 1) Lookup produit
    // ------------------------------------------------------------
    const sku = extractSku(input);
    debug.extractedSku = sku;

    let productContext = "";
    let productUrl: string | undefined;

    if (sku) {
      const candidates = skuCandidates(sku);
      debug.skuCandidates = candidates;

      // 1A) exact match product_reference
      for (const c of candidates) {
        const { data, error } = await supa
          .from("products")
          .select("*")
          .eq("product_reference", c)
          .limit(1)
          .maybeSingle();

        if (error) debug.supabaseErrors.push(`exact product_reference ${c}: ${error.message}`);
        if (data) {
          debug.lookup.exact_product_reference = { matched: c, id: data.id };
          const p = data as any;
          productUrl = normalizeUrl(p.url) || buildProductUrlFromSlug(p.slug);

          const priceStr = moneyToString(p.price, p.currency);
          const ref = p.product_reference || sku;

          productContext =
            `### Produit CamProtect (source de vérité)\n` +
            `Référence: ${ref}\n` +
            `Nom: ${p.name || "N/A"}\n` +
            `Marque: ${p.brand || "N/A"}\n` +
            `Type: ${p.product_type || p.type || "N/A"}\n` +
            `Prix: ${priceStr}\n` +
            `Lien CamProtect: ${productUrl || "N/A"}\n` +
            `Description: ${p.description || p.description_complete || p.description_mini || "N/A"}\n`;

          break;
        }
      }

      // 1B) fallback: ilike sur product_reference (si stocké différemment)
      if (!productContext) {
        const needle = candidates[0];
        const { data, error } = await supa
          .from("products")
          .select("*")
          .ilike("product_reference", `%${needle}%`)
          .limit(1)
          .maybeSingle();

        if (error) debug.supabaseErrors.push(`ilike product_reference %${needle}%: ${error.message}`);
        if (data) {
          debug.lookup.ilike_product_reference = { needle, id: data.id };
          const p = data as any;
          productUrl = normalizeUrl(p.url) || buildProductUrlFromSlug(p.slug);

          productContext =
            `### Produit CamProtect (source de vérité)\n` +
            `Référence: ${p.product_reference || sku}\n` +
            `Nom: ${p.name || "N/A"}\n` +
            `Marque: ${p.brand || "N/A"}\n` +
            `Type: ${p.product_type || p.type || "N/A"}\n` +
            `Prix: ${moneyToString(p.price, p.currency)}\n` +
            `Lien CamProtect: ${productUrl || "N/A"}\n` +
            `Description: ${p.description || p.description_complete || p.description_mini || "N/A"}\n`;
        }
      }

      // 1C) fallback slug / name ilike
      if (!productContext) {
        const needle = candidates[0].toLowerCase();

        const q1 = await supa.from("products").select("*").ilike("slug", `%${needle}%`).limit(1).maybeSingle();
        if (q1.error) debug.supabaseErrors.push(`ilike slug %${needle}%: ${q1.error.message}`);
        if (q1.data) {
          debug.lookup.ilike_slug = { needle, id: q1.data.id };
          const p: any = q1.data;
          productUrl = normalizeUrl(p.url) || buildProductUrlFromSlug(p.slug);
          productContext =
            `### Produit CamProtect (source de vérité)\n` +
            `Référence: ${p.product_reference || sku}\n` +
            `Nom: ${p.name || "N/A"}\n` +
            `Marque: ${p.brand || "N/A"}\n` +
            `Lien CamProtect: ${productUrl || "N/A"}\n`;
        }
      }

      if (!productContext) {
        const needle = candidates[0];
        const q2 = await supa.from("products").select("*").ilike("name", `%${needle}%`).limit(1).maybeSingle();
        if (q2.error) debug.supabaseErrors.push(`ilike name %${needle}%: ${q2.error.message}`);
        if (q2.data) {
          debug.lookup.ilike_name = { needle, id: q2.data.id };
          const p: any = q2.data;
          productUrl = normalizeUrl(p.url) || buildProductUrlFromSlug(p.slug);
          productContext =
            `### Produit CamProtect (source de vérité)\n` +
            `Référence: ${p.product_reference || sku}\n` +
            `Nom: ${p.name || "N/A"}\n` +
            `Marque: ${p.brand || "N/A"}\n` +
            `Lien CamProtect: ${productUrl || "N/A"}\n`;
        }
      }
    }

    // ------------------------------------------------------------
    // 2) RAG docs si pas trouvé
    // ------------------------------------------------------------
    let ragUsed = 0;
    let ragSources: RagSource[] = [];
    let docsContext = "";

    if (!productContext) {
      const embedding = await embedText(input);
      const { data: docs, error: rpcErr } = await supa.rpc("match_documents", {
        query_embedding: embedding,
        match_count: topK,
      });

      if (rpcErr) {
        return Response.json(
          { ok: false, error: "Supabase match_documents failed", details: rpcErr.message, debug: debugMode ? debug : undefined },
          { status: 500 }
        );
      }

      if (Array.isArray(docs) && docs.length > 0) {
        ragUsed = docs.length;

        ragSources = docs.map((d: any) => ({
          id: Number(d.id),
          title: d.title || d.source || undefined,
          url: normalizeUrl(d.url),
          similarity: typeof d.similarity === "number" ? d.similarity : undefined,
        }));

        const blocks = docs.map((d: any, idx: number) => {
          const title = d.title || d.source || `Doc ${idx + 1}`;
          const url = normalizeUrl(d.url);
          const content = d.chunk || d.content || "";
          return `---\n[DOC ${idx + 1}] ${title}\nURL: ${url || "N/A"}\nCONTENU:\n${content}\n`;
        });

        docsContext = `### Contexte CamProtect (documents)\n${blocks.join("\n")}\n`;
      }
    } else {
      ragUsed = 1;
      ragSources = [{ id: 0, title: "Produit CamProtect", url: productUrl, similarity: 1 }];
    }

    // ------------------------------------------------------------
    // 3) IA
    // ------------------------------------------------------------
    const context = (productContext ? productContext + "\n" : "") + (docsContext ? docsContext : "");

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      {
        role: "system" as const,
        content: context
          ? `Tu disposes du CONTEXTE ci-dessous. Utilise-le en priorité.\n\n${context}`
          : `Aucun contexte interne trouvé. Demande une précision utile et propose des alternatives disponibles sur CamProtect.`,
      },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: ragUsed, sources: ragSources },
      debug: debugMode ? debug : undefined,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
