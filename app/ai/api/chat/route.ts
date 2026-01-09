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
  title: string | null;
  url: string | null;
  price: number | null;
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  channels: number | null;
  poe: boolean;
  ip: boolean;
};

function extractChannels(text: string): number | null {
  if (!text) return null;

  // "4 canaux", "8 canaux", "16 canaux"
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch)\b/i);
  if (m1) return Number(m1[1]);

  // "4CH", "8CH", "16CH"
  const m2 = text.match(/\b(\d{1,2})\s*ch\b/i);
  if (m2) return Number(m2[1]);

  return null;
}

function detectNeed(input: string) {
  const t = input.toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsPoE = t.includes("poe");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch)\b/i);
  const channels = m ? Number(m[1]) : null;

  // si l’utilisateur dit “pour 4 caméras”, on l’interprète comme un minimum de 4 canaux
  const requestedChannels = channels && channels > 0 ? channels : null;

  return {
    wantsRecorder,
    wantsIP,
    wantsPoE,
    requestedChannels,
  };
}

function pickBestRecorder(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  if (!requestedChannels) {
    // si pas de demande de canaux, on prend le "plus petit" raisonnable (ex: 8 plutôt que 16 si possible)
    const sorted = [...candidates].sort((a, b) => {
      const ca = a.channels ?? 9999;
      const cb = b.channels ?? 9999;
      return ca - cb;
    });
    return { exact: sorted[0] ?? null, fallback: null };
  }

  // exact match
  const exact = candidates.find((c) => c.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  // fallback = prochain supérieur
  const higher = candidates
    .filter((c) => typeof c.channels === "number" && (c.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;
    const input = (body.input || "").trim();
    if (!input) return Response.json({ ok: false, error: "Missing input" }, { status: 400 });

    const debug = !!body.debug;
    const conversationId = body.conversationId ?? crypto.randomUUID();

    const need = detectNeed(input);

    const supa = supabaseAdmin();

    // 1) Charger des candidats “enregistreurs”
    // On évite d’attraper des caméras/accessoires.
    // Si l’utilisateur parle IP/PoE -> on privilégie les NVR PoE (et on exclut DVR/XVR analogiques si possible).
    const { data: raw, error } = await supa
      .from("products")
      .select("id,title,url,price,currency,product_type,sku,payload")
      .limit(80);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows = Array.isArray(raw) ? raw : [];

    // 2) Construire & filtrer candidats
    const candidatesAll: Candidate[] = rows
      .map((r: any) => {
        const title = (r.title || r.payload?.name || "").toString();
        const productType = (r.product_type || "").toString();
        const hay = `${title} ${productType} ${r.sku || ""}`.toLowerCase();

        const channels = extractChannels(title);
        const poe = hay.includes("poe");
        const ip = hay.includes("nvr") || hay.includes("ip");

        return {
          id: Number(r.id),
          title: title || null,
          url: (r.url || null) as string | null,
          price: typeof r.price === "number" ? r.price : null,
          currency: (r.currency || "EUR") as string | null,
          product_type: productType || null,
          sku: (r.sku || null) as string | null,
          channels,
          poe,
          ip,
        };
      })
      // garde seulement enregistreurs (NVR/DVR/XVR) via mots-clés titre/type
      .filter((c) => {
        const t = (c.title || "").toLowerCase();
        const pt = (c.product_type || "").toLowerCase();
        return (
          t.includes("enregistreur") ||
          t.includes("nvr") ||
          t.includes("dvr") ||
          t.includes("xvr") ||
          pt.includes("nvr") ||
          pt.includes("dvr") ||
          pt.includes("xvr")
        );
      });

    // Filtre spécifique si IP + PoE demandés : on veut NVR PoE (donc ip=true et poe=true)
    let candidates = candidatesAll;

    if (need.wantsIP) candidates = candidates.filter((c) => c.ip);
    if (need.wantsPoE) candidates = candidates.filter((c) => c.poe);

    // Si ça a trop filtré (0 résultat), on relâche un peu : IP sans PoE etc.
    if (!candidates.length && need.wantsIP) {
      candidates = candidatesAll.filter((c) => c.ip);
    }
    if (!candidates.length) {
      candidates = candidatesAll;
    }

    // 3) Choix meilleur match
    const picked = pickBestRecorder(candidates, need.requestedChannels);

    // Sources RAG = liste des candidats visibles (URLs exactes)
    const ragSources = candidates.slice(0, 6).map((c) => ({ id: c.id, url: c.url }));

    // 4) Construire contexte ultra-strict pour éviter URL inventée
    const formatCandidate = (c: Candidate) => {
      const priceStr =
        typeof c.price === "number" ? `${c.price} ${c.currency || "EUR"}` : "Non affiché (voir page produit)";
      return [
        `ID: ${c.id}`,
        `Titre: ${c.title || "N/A"}`,
        `SKU: ${c.sku || "N/A"}`,
        `Canaux: ${c.channels ?? "N/A"}`,
        `PoE: ${c.poe ? "oui" : "non"}`,
        `IP/NVR: ${c.ip ? "oui" : "non"}`,
        `Prix: ${priceStr}`,
        `URL EXACTE: ${c.url || "N/A"}`,
      ].join("\n");
    };

    const exactBlock = picked.exact ? `\n[PRODUIT EXACT]\n${formatCandidate(picked.exact)}\n` : "";
    const fallbackBlock = picked.fallback ? `\n[PRODUIT ALTERNATIF]\n${formatCandidate(picked.fallback)}\n` : "";

    const policy = `
RÈGLES CRITIQUES:
- N’invente JAMAIS d’URL. Utilise UNIQUEMENT "URL EXACTE" telle quelle.
- Si aucun produit EXACT n’existe (ex: demandé 4 canaux), dis-le explicitement, puis propose l'ALTERNATIF (ex: 8 canaux).
- Affiche le PRIX si disponible; sinon écris "Prix : voir page produit".
- Si l’utilisateur demande IP PoE => privilégie les NVR PoE.
- Réponse courte, claire, orientée achat CamProtect.
- Toujours terminer par 1 à 3 questions utiles (HDD, 4K, marques, etc.).
`.trim();

    const needSummary = `
BESOIN CLIENT (détecté):
- Enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- IP/NVR: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés (min): ${need.requestedChannels ?? "non précisé"}
`.trim();

    const context = `
${policy}

${needSummary}
${exactBlock}
${fallbackBlock}
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: context },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: candidates.length ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              picked: {
                exact: picked.exact ? { id: picked.exact.id, url: picked.exact.url, channels: picked.exact.channels } : null,
                fallback: picked.fallback
                  ? { id: picked.fallback.id, url: picked.fallback.url, channels: picked.fallback.channels }
                  : null,
              },
              candidates: candidates.slice(0, 6),
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
