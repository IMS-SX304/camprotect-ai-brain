// app/ai/api/chat/route.ts
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { chatCompletion, embedText, CAMPROTECT_SYSTEM_PROMPT } from "../../../../lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  topK?: number;
};

type RagSource = {
  id: number;
  title?: string;
  url?: string; // jamais null
  similarity?: number;
};

function extractSku(text: string): string | null {
  // Ex: DS-7616NXI-I2-S, DS-7616NXI-I2/S, NVR4104HS-4KS3, 52271.146.WH1, etc.
  const m = text.match(/[A-Z0-9]{2,}([-.\/][A-Z0-9]{1,}){1,10}/i);
  if (!m) return null;
  return m[0].toUpperCase();
}

function normalizeUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  const trimmed = String(u).trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    return url.toString();
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

function skuCandidates(sku: string): string[] {
  // Permet de matcher DS-7616NXI-I2/S vs DS-7616NXI-I2-S
  const s = sku.toUpperCase().trim();
  const a = s;
  const b = s.replace(/\//g, "-");
  const c = s.replace(/-/g, "/");
  // unique
  return Array.from(new Set([a, b, c])).filter(Boolean);
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

    const supa = supabaseAdmin();

    // ------------------------------------------------------------
    // 1) Lookup produit direct si SKU détecté
    //    IMPORTANT: chez toi la référence est dans products.product_reference
    // ------------------------------------------------------------
    const sku = extractSku(input);
    let productContext = "";
    let productUrl: string | undefined;

    if (sku) {
      const candidates = skuCandidates(sku);

      // On tente match exact sur product_reference (et slug si jamais)
      // => or() permet d’essayer plusieurs valeurs
      const orParts: string[] = [];
      for (const c of candidates) {
        orParts.push(`product_reference.eq.${c}`);
        orParts.push(`slug.eq.${c.toLowerCase()}`);
      }

      // NOTE: select("*") évite les erreurs si tes colonnes évoluent
      const { data: p, error: pErr } = await supa
        .from("products")
        .select("*")
        .or(orParts.join(","))
        .limit(1)
        .maybeSingle();

      if (!pErr && p) {
        // URL priorité: colonne url -> sinon base + slug
        productUrl = normalizeUrl(p.url) || buildProductUrlFromSlug(p.slug);

        // prix: si tu as un champ price/currency dans products, on l’utilise
        const priceStr = moneyToString(p.price, p.currency);

        const payloadStr =
          p.payload && typeof p.payload === "object" && Object.keys(p.payload).length > 0
            ? `\nDonnées techniques (payload): ${JSON.stringify(p.payload)}`
            : "";

        const ref = p.product_reference || p.sku || sku;

        productContext =
          `### Produit CamProtect (source de vérité)\n` +
          `Référence: ${ref}\n` +
          `Nom: ${p.name || "N/A"}\n` +
          `Marque: ${p.brand || "N/A"}\n` +
          `Type: ${p.product_type || p.type || "N/A"}\n` +
          `Prix: ${priceStr}\n` +
          `Lien CamProtect: ${productUrl || "N/A"}\n` +
          `Description: ${p.description || p.description_complete || p.description_mini || "N/A"}\n` +
          payloadStr +
          `\n`;
      }
    }

    // ------------------------------------------------------------
    // 2) RAG docs si pas trouvé
    // ------------------------------------------------------------
    let ragUsed = 0;
    let ragSources: RagSource[] = [];
    let docsContext = "";

    const shouldUseDocs = !productContext;

    if (shouldUseDocs) {
      const embedding = await embedText(input);

      const { data: docs, error: rpcErr } = await supa.rpc("match_documents", {
        query_embedding: embedding,
        match_count: topK,
      });

      if (rpcErr) {
        return Response.json(
          { ok: false, error: "Supabase match_documents failed", details: rpcErr.message },
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
      ragSources = [
        { id: 0, title: "Produit CamProtect", url: productUrl, similarity: 1 },
      ];
    }

    // ------------------------------------------------------------
    // 3) IA
    // ------------------------------------------------------------
    const context =
      (productContext ? productContext + "\n" : "") + (docsContext ? docsContext : "");

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      {
        role: "system" as const,
        content: context
          ? `Tu disposes du CONTEXTE ci-dessous. Utilise-le en priorité.\n\n${context}`
          : `Aucun contexte interne trouvé. Tu dois demander une précision utile et proposer des alternatives disponibles sur CamProtect.`,
      },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: ragUsed, sources: ragSources },
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
