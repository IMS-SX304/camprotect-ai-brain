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
  url?: string; // IMPORTANT: undefined (pas null) pour TS
  similarity?: number;
};

function extractSku(text: string): string | null {
  // Capte des refs type: DS-7616NXI-I2-S, NVR4104HS-4KS3, etc.
  // On évite de capturer des mots trop courts.
  const m = text.match(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}\b/i);
  return m ? m[0].toUpperCase() : null;
}

function normalizeUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.toString();
  } catch {
    const trimmed = String(u).trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("/")) return `https://camprotect.fr${trimmed}`;
    return `https://camprotect.fr/${trimmed.replace(/^https?:\/\//, "")}`;
  }
}

function normalizeSkuForSearch(sku: string): string {
  // enlève tirets, slash, espaces, underscore => pour trouver des variantes
  return sku.replace(/[-\/\s_]/g, "").toUpperCase();
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

    // =========================
    // 1) Lookup direct produit si SKU détecté (priorité)
    // =========================
    const sku = extractSku(input);
    let productContext = "";
    let productUrl: string | undefined;

    if (sku) {
      // 1) exact match
      const { data: pExact, error: errExact } = await supa
        .from("products")
        .select("sku,name,brand,product_type,url,price,currency,description,payload")
        .eq("sku", sku)
        .maybeSingle();

      // 2) ilike fallback
      let p = pExact;
      if (!p) {
        const { data: pLike, error: errLike } = await supa
          .from("products")
          .select("sku,name,brand,product_type,url,price,currency,description,payload")
          .ilike("sku", `%${sku}%`)
          .limit(1)
          .maybeSingle();

        if (!errLike && pLike) p = pLike;
      }

      // 3) normalisé (si en base c’est stocké différemment)
      if (!p) {
        const skuNorm = normalizeSkuForSearch(sku);
        // on récupère quelques lignes candidates et on compare côté code
        const { data: candidates, error: errCand } = await supa
          .from("products")
          .select("sku,name,brand,product_type,url,price,currency,description,payload")
          .ilike("sku", `%${sku.slice(0, 6)}%`) // petit filet large
          .limit(25);

        if (!errCand && Array.isArray(candidates)) {
          const found = candidates.find((c: any) => normalizeSkuForSearch(String(c.sku || "")) === skuNorm);
          if (found) p = found as any;
        }
      }

      if (p) {
        productUrl = normalizeUrl(p.url);

        const priceStr =
          p.price !== null && p.price !== undefined
            ? `${p.price} ${p.currency || "EUR"}`
            : "N/A";

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

    // =========================
    // 2) RAG documents si pas de produit trouvé (ou pas de SKU)
    // =========================
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
      // On a trouvé un produit exact -> on considère qu'on a 1 source interne fiable
      ragUsed = 1;
      ragSources = [
        {
          id: 0,
          title: "Produit CamProtect",
          url: productUrl,
          similarity: 1,
        },
      ];
    }

    // =========================
    // 3) Appel IA avec contexte
    // =========================
    const context = (productContext ? productContext + "\n" : "") + (docsContext ? docsContext : "");

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      {
        role: "system" as const,
        content: context
          ? `Tu disposes du CONTEXTE ci-dessous. Utilise-le en priorité.\n\n${context}`
          : `Aucun contexte interne trouvé. Dans ce cas, tu demandes une précision et tu proposes des alternatives disponibles sur CamProtect.`,
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
