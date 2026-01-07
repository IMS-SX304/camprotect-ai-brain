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
  url?: string; // IMPORTANT: string | undefined (pas null)
  similarity?: number;
};

function extractSku(text: string): string | null {
  // Ex: DS-7616NXI-I2-S, NVR4104HS-4KS3, 52271.146.WH1 etc.
  // On capte des patterns alphanum + séparateurs - . /
  const m = text.match(/[A-Z0-9]{2,}([-.\/][A-Z0-9]{2,}){1,6}/i);
  if (!m) return null;
  return m[0].toUpperCase();
}

function normalizeUrl(u?: string | null): string | undefined {
  // Retourne string | undefined (jamais null)
  if (!u) return undefined;

  const trimmed = String(u).trim();
  if (!trimmed) return undefined;

  try {
    // déjà absolute
    const url = new URL(trimmed);
    return url.toString();
  } catch {
    // relative -> camprotect.fr
    if (trimmed.startsWith("/")) return `https://www.camprotect.fr${trimmed}`;
    return `https://www.camprotect.fr/${trimmed.replace(/^https?:\/\//, "")}`;
  }
}

function moneyToString(price: any, currency?: string | null): string {
  if (price === null || price === undefined) return "N/A";
  // price peut être number (ex: 399) ou string
  const n = typeof price === "number" ? price : Number(price);
  if (Number.isNaN(n)) return "N/A";
  return `${n} ${(currency || "EUR").toUpperCase()}`;
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
    // 1) Priorité: lookup produit direct si SKU détecté
    // ------------------------------------------------------------
    const sku = extractSku(input);

    let productContext = "";
    let productUrl: string | undefined = undefined;

    if (sku) {
      const { data: p, error: pErr } = await supa
        .from("products")
        .select("id,sku,name,brand,product_type,url,price,currency,description,payload")
        .eq("sku", sku)
        .maybeSingle();

      if (!pErr && p) {
        productUrl = normalizeUrl(p.url);
        const priceStr = moneyToString(p.price, p.currency);

        const payloadStr =
          p.payload && typeof p.payload === "object" && Object.keys(p.payload).length > 0
            ? `\nDonnées techniques (payload): ${JSON.stringify(p.payload)}`
            : "";

        productContext =
          `### Produit CamProtect (source de vérité)\n` +
          `SKU: ${p.sku}\n` +
          `Nom: ${p.name || "N/A"}\n` +
          `Marque: ${p.brand || "N/A"}\n` +
          `Type: ${p.product_type || "N/A"}\n` +
          `Prix: ${priceStr}\n` +
          `Lien CamProtect: ${productUrl || "N/A"}\n` +
          `Description: ${p.description || "N/A"}\n` +
          payloadStr +
          `\n`;
      }
    }

    // ------------------------------------------------------------
    // 2) RAG docs si pas de produit trouvé
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
        {
          id: 0,
          title: "Produit CamProtect",
          url: productUrl, // string|undefined OK
          similarity: 1,
        },
      ];
    }

    // ------------------------------------------------------------
    // 3) Appel IA (CamProtect-first)
    // ------------------------------------------------------------
    const context =
      (productContext ? productContext + "\n" : "") +
      (docsContext ? docsContext : "");

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      {
        role: "system" as const,
        content: context
          ? `Tu disposes du CONTEXTE ci-dessous. Utilise-le en priorité.\n\n${context}`
          : `Aucun contexte interne trouvé. Dans ce cas, tu dois:\n- demander une précision utile (marque, référence, usage)\n- proposer des alternatives disponibles sur CamProtect\n- éviter d’envoyer l’utilisateur vers d’autres sites`,
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
