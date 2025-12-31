// app/ai/api/chat/route.ts
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { chatCompletion, embedText, CAMPROTECT_SYSTEM_PROMPT } from "../../../../lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  topK?: number;
};

function extractSku(text: string): string | null {
  // Ex: DS-7616NXI-I2-S, NVR4104HS-4KS3, etc.
  const m = text.match(/[A-Z0-9]{2,}-[A-Z0-9-]{3,}/i);
  return m ? m[0].toUpperCase() : null;
}

function normalizeUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    // Si déjà absolute URL
    const url = new URL(u);
    return url.toString();
  } catch {
    // Sinon, on tente de le forcer en relatif camprotect.fr
    const trimmed = u.trim();
    if (trimmed.startsWith("/")) return `https://camprotect.fr${trimmed}`;
    return `https://camprotect.fr/${trimmed.replace(/^https?:\/\//, "")}`;
  }
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

    // 1) Lookup direct produit si SKU détecté (priorité)
    const sku = extractSku(input);
    let productContext = "";
    let productUrl: string | null = null;

    if (sku) {
      const { data: p, error } = await supa
        .from("products")
        .select("sku,name,brand,product_type,url,price,currency,description,payload")
        .eq("sku", sku)
        .maybeSingle();

      if (!error && p) {
        productUrl = normalizeUrl(p.url);
        const priceStr =
          p.price !== null && p.price !== undefined
            ? `${p.price} ${p.currency || "EUR"}`
            : "N/A";

        // payload: tu peux y mettre plein d’infos CMS (specs, compatibilités…)
        const payloadStr =
          p.payload && Object.keys(p.payload).length > 0
            ? `\nDonnées techniques (payload): ${JSON.stringify(p.payload)}`
            : "";

        productContext =
          `### Produit CamProtect (source de vérité)\n` +
          `SKU: ${p.sku}\n` +
          `Nom: ${p.name}\n` +
          `Marque: ${p.brand || "N/A"}\n` +
          `Type: ${p.product_type || "N/A"}\n` +
          `Prix: ${priceStr}\n` +
          `Lien CamProtect: ${productUrl || "N/A"}\n` +
          `Description: ${p.description || "N/A"}\n` +
          payloadStr +
          `\n`;
      }
    }

    // 2) RAG documents si pas de produit trouvé (ou pas de SKU)
    let ragUsed = 0;
    let ragSources: Array<{ id: number; title?: string; url?: string; similarity?: number }> = [];
    let docsContext = "";

    // On n’empile pas trop: si on a déjà le produit exact, les docs sont optionnels.
    const shouldUseDocs = !productContext;

    if (shouldUseDocs) {
      const embedding = await embedText(input);

      const { data: docs, error: rpcErr } = await supa.rpc("match_documents", {
        query_embedding: embedding,
        match_count: topK,
      });

      if (rpcErr) {
        // On ne bloque pas toute la réponse : on remonte l'erreur proprement
        return Response.json(
          { ok: false, error: "Supabase match_documents failed", details: rpcErr.message },
          { status: 500 }
        );
      }

      if (Array.isArray(docs) && docs.length > 0) {
        ragUsed = docs.length;

        ragSources = docs.map((d: any) => ({
          id: d.id,
          title: d.title || d.source,
          url: normalizeUrl(d.url),
          similarity: typeof d.similarity === "number" ? d.similarity : undefined,
        }));

        // On construit un contexte court et clair
        const blocks = docs.map((d: any, idx: number) => {
          const title = d.title || d.source || `Doc ${idx + 1}`;
          const url = normalizeUrl(d.url);
          const content = d.chunk || d.content || ""; // selon ton schéma
          return `---\n[DOC ${idx + 1}] ${title}\nURL: ${url || "N/A"}\nCONTENU:\n${content}\n`;
        });

        docsContext = `### Contexte CamProtect (documents)\n${blocks.join("\n")}\n`;
      }
    } else {
      ragUsed = 1;
      ragSources = productUrl
        ? [{ id: 0, title: "Produit CamProtect", url: productUrl, similarity: 1 }]
        : [{ id: 0, title: "Produit CamProtect", url: undefined, similarity: 1 }];
    }

    // 3) Appel OpenAI avec règles CamProtect-first
    const context =
      (productContext ? productContext + "\n" : "") + (docsContext ? docsContext : "");

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      {
        role: "system" as const,
        content:
          context
            ? `Tu disposes du CONTEXTE ci-dessous. Utilise-le en priorité.\n\n${context}`
            : `Aucun contexte interne trouvé. Dans ce cas, tu dois demander une précision et proposer des alternatives disponibles CamProtect.`,
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
