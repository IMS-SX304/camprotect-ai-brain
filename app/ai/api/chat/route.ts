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
  price: number | null; // ✅ prix final HT (produit ou min variant)
  currency: string | null;
  product_type: string | null;
  sku: string | null;

  fiche_technique_url?: string | null; // ✅ FT

  channels: number | null;
  poe: boolean;
  ip: boolean;

  // debug only
  min_variant_price?: number | null;
};

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function detectNeed(input: string) {
  const t = input.toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsPoE = t.includes("poe");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const channels = m ? Number(m[1]) : null;

  return {
    wantsRecorder,
    wantsIP,
    wantsPoE,
    requestedChannels: channels && channels > 0 ? channels : null,
  };
}

function pickBestRecorder(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  if (!requestedChannels) {
    const sorted = [...candidates].sort((a, b) => {
      const ca = a.channels ?? 9999;
      const cb = b.channels ?? 9999;
      return ca - cb;
    });
    return { exact: sorted[0] ?? null, fallback: null };
  }

  const exact = candidates.find((c) => c.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = candidates
    .filter((c) => typeof c.channels === "number" && (c.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

// ✅ HT -> TTC (20%)
function toTTC(priceHT: number | null, rate = 0.2): number | null {
  if (typeof priceHT !== "number") return null;
  return Math.round(priceHT * (1 + rate) * 100) / 100;
}

function formatMoneyFR(n: number): string {
  // 112.7 => "112,70"
  return n.toFixed(2).replace(".", ",");
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

    // 1) Load products
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(300);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows = Array.isArray(raw) ? raw : [];
    const productIds = rows.map((r: any) => Number(r.id)).filter((n) => Number.isFinite(n));

    // 2) Load min price per product from variants (fallback)
    const minPriceByProductId = new Map<number, number>();

    if (productIds.length) {
      const { data: vars, error: vErr } = await supa
        .from("product_variants")
        .select("product_id,price")
        .in("product_id", productIds);

      if (!vErr && Array.isArray(vars)) {
        for (const v of vars as any[]) {
          const pid = Number(v.product_id);
          const p = typeof v.price === "number" ? v.price : null;
          if (!Number.isFinite(pid) || p === null) continue;

          const prev = minPriceByProductId.get(pid);
          if (prev === undefined || p < prev) minPriceByProductId.set(pid, p);
        }
      }
    }

    const candidatesAll: Candidate[] = rows
      .map((r: any) => {
        const name = (r.name || r.payload?.name || "").toString();
        const productType = (r.product_type || "").toString();
        const hay = `${name} ${productType} ${r.sku || ""}`.toLowerCase();

        const channels = extractChannels(name);
        const poe = hay.includes("poe");
        const ip = hay.includes("nvr") || hay.includes("ip");

        const pid = Number(r.id);
        const minVar = minPriceByProductId.get(pid) ?? null;

        // ✅ prix final HT : prix produit sinon min variant
        const finalPriceHT =
          typeof r.price === "number" ? r.price : (typeof minVar === "number" ? minVar : null);

        return {
          id: pid,
          name: name || null,
          url: (r.url || null) as string | null,

          price: finalPriceHT,
          currency: (r.currency || "EUR") as string | null,
          product_type: productType || null,
          sku: (r.sku || null) as string | null,

          // ✅ IMPORTANT : on mappe la FT !
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,

          channels,
          poe,
          ip,
          min_variant_price: minVar,
        };
      })
      .filter((c) => {
        const t = (c.name || "").toLowerCase();
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

    let candidates = candidatesAll;
    if (need.wantsIP) candidates = candidates.filter((c) => c.ip);
    if (need.wantsPoE) candidates = candidates.filter((c) => c.poe);

    if (!candidates.length && need.wantsIP) {
      candidates = candidatesAll.filter((c) => c.ip);
    }
    if (!candidates.length) {
      candidates = candidatesAll;
    }

    const picked = pickBestRecorder(candidates, need.requestedChannels);

    const ragSources = candidates.slice(0, 6).map((c) => ({ id: c.id, url: c.url }));

    const formatPriceTTC = (c: Candidate) => {
      const ttc = toTTC(c.price, 0.2);
      if (typeof ttc === "number") return `${formatMoneyFR(ttc)} ${c.currency || "EUR"} TTC`;
      return "Prix : voir page produit";
    };

    const formatCandidate = (c: Candidate) => {
      const lines = [
        `ID: ${c.id}`,
        `Nom: ${c.name || "N/A"}`,
        `SKU: ${c.sku || "N/A"}`,
        `Canaux: ${c.channels ?? "N/A"}`,
        `PoE: ${c.poe ? "oui" : "non"}`,
        `IP/NVR: ${c.ip ? "oui" : "non"}`,
        `Prix TTC: ${formatPriceTTC(c)}`,
        `URL EXACTE: ${c.url || "N/A"}`,
      ];

      // ✅ FT pour contexte LLM
      if (c.fiche_technique_url) lines.push(`FICHE TECHNIQUE URL: ${c.fiche_technique_url}`);

      return lines.join("\n");
    };

    const policy = `
FORMAT DE RÉPONSE OBLIGATOIRE:
1) "✅ Produit recommandé" (si exact) ou "ℹ️ Alternative proposée" (si pas exact)
2) 3 à 8 lignes max: nom, canaux, PoE, prix TTC, lien
3) Si l'utilisateur demande 4 canaux et qu'on propose 8: dire explicitement
   "Nous n’avons pas de 4 canaux PoE IP, voici la meilleure alternative 8 canaux."
4) N’invente JAMAIS d’URL. Utilise UNIQUEMENT "URL EXACTE".
5) Affiche le prix en TTC si présent, sinon "Prix : voir page produit".
6) Si "FICHE TECHNIQUE URL" est présent, ajouter une ligne:
   "📄 Fiche technique : <lien>"
7) Toujours finir par 2-3 questions (HDD, 4K, marque, caméras existantes).
`.trim();

    const needSummary = `
BESOIN CLIENT:
- IP/NVR: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés: ${need.requestedChannels ?? "non précisé"}
`.trim();

    const exactBlock = picked.exact ? `\n[PRODUIT EXACT]\n${formatCandidate(picked.exact)}\n` : "";
    const fallbackBlock = picked.fallback ? `\n[PRODUIT ALTERNATIF]\n${formatCandidate(picked.fallback)}\n` : "";

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

    const used = picked.exact || picked.fallback ? 1 : 0;

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              picked: {
                exact: picked.exact
                  ? {
                      id: picked.exact.id,
                      url: picked.exact.url,
                      channels: picked.exact.channels,
                      price: picked.exact.price,
                      fiche_technique_url: picked.exact.fiche_technique_url ?? null,
                    }
                  : null,
                fallback: picked.fallback
                  ? {
                      id: picked.fallback.id,
                      url: picked.fallback.url,
                      channels: picked.fallback.channels,
                      price: picked.fallback.price,
                      fiche_technique_url: picked.fallback.fiche_technique_url ?? null,
                    }
                  : null,
              },
              candidates: candidates.slice(0, 6),
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
