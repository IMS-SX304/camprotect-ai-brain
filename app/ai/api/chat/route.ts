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

  // HT stocké côté Webflow/Supabase
  price: number | null;
  currency: string | null;

  product_type: string | null;
  sku: string | null;

  fiche_technique_url?: string | null;

  brand_option_id?: string | null;
  brand_name?: string | null;

  channels: number | null;
  poe: boolean;
  ip: boolean;
};

const VAT_RATE = 0.2;

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

  const wantsCamera =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsPoE = t.includes("poe");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const channels = m ? Number(m[1]) : null;

  return {
    wantsRecorder,
    wantsCamera,
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

function looksLikeRecorder(c: Candidate) {
  const t = (c.name || "").toLowerCase();
  const pt = (c.product_type || "").toLowerCase();
  const hay = `${t} ${pt} ${(c.sku || "").toLowerCase()}`;
  return hay.includes("enregistreur") || hay.includes("nvr") || hay.includes("dvr") || hay.includes("xvr");
}

function looksLikeCamera(c: Candidate) {
  const t = (c.name || "").toLowerCase();
  const pt = (c.product_type || "").toLowerCase();
  const hay = `${t} ${pt} ${(c.sku || "").toLowerCase()}`;
  return (
    hay.includes("caméra") ||
    hay.includes("camera") ||
    hay.includes("bullet") ||
    hay.includes("dôme") ||
    hay.includes("dome")
  );
}

function eur(n: number) {
  return n.toFixed(2).replace(".", ",");
}
function htToTtc(ht: number) {
  return ht * (1 + VAT_RATE);
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

    // 0) Mapping fabricants (option_id -> option_name)
    const brandMap = new Map<string, string>();
    {
      const { data: opts } = await supa
        .from("webflow_option_map")
        .select("option_id, option_name")
        .eq("field_slug", "fabricants")
        .limit(500);

      if (Array.isArray(opts)) {
        for (const o of opts as any[]) {
          if (o?.option_id && o?.option_name) brandMap.set(String(o.option_id), String(o.option_name));
        }
      }
    }

    // 1) Load products (limite raisonnable pour éviter timeout)
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,brand,payload")
      .limit(450);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows = Array.isArray(raw) ? raw : [];

    // 2) Build candidates + brand readable + exclude AJAX
    const candidatesAll: Candidate[] = rows
      .map((r: any) => {
        const name = (r.name || r.payload?.name || "").toString().trim() || null;
        const productType = (r.product_type || "").toString().trim() || null;
        const sku = (r.sku || null) as string | null;

        const hay = `${name || ""} ${productType || ""} ${sku || ""}`.toLowerCase();
        const channels = extractChannels(name || "");
        const poe = hay.includes("poe");
        const ip = hay.includes("nvr") || hay.includes("ip");

        const brandOptionId = (r.brand ?? r.payload?.brand ?? null) as string | null;
        const brandName = brandOptionId ? (brandMap.get(String(brandOptionId)) ?? null) : null;

        return {
          id: Number(r.id),
          name,
          url: (r.url || null) as string | null,
          price: typeof r.price === "number" ? r.price : null, // HT
          currency: (r.currency || "EUR") as string | null,
          product_type: productType,
          sku,
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,
          brand_option_id: brandOptionId,
          brand_name: brandName,
          channels,
          poe,
          ip,
        };
      })
      // ✅ exclure tous les produits AJAX
      .filter((c) => (c.brand_name || "").toUpperCase() !== "AJAX");

    // 3) Recorder candidates
    let recorderCandidates = candidatesAll.filter(looksLikeRecorder);
    if (need.wantsIP) recorderCandidates = recorderCandidates.filter((c) => c.ip);
    if (need.wantsPoE) recorderCandidates = recorderCandidates.filter((c) => c.poe);

    if (!recorderCandidates.length && need.wantsIP) {
      recorderCandidates = candidatesAll.filter(looksLikeRecorder).filter((c) => c.ip);
    }
    if (!recorderCandidates.length) {
      recorderCandidates = candidatesAll.filter(looksLikeRecorder);
    }

    const picked = pickBestRecorder(recorderCandidates, need.requestedChannels);

    // 4) Camera candidates (si demandé)
    let cameraCandidates: Candidate[] = [];
    if (need.wantsCamera) {
      cameraCandidates = candidatesAll
        .filter(looksLikeCamera)
        .filter((c) => typeof c.price === "number" && !!c.url)
        .sort((a, b) => (a.price as number) - (b.price as number))
        .slice(0, 3);
    }

    const ragSources = [
      ...(picked.exact ? [{ id: picked.exact.id, url: picked.exact.url }] : []),
      ...(picked.fallback ? [{ id: picked.fallback.id, url: picked.fallback.url }] : []),
      ...cameraCandidates.map((c) => ({ id: c.id, url: c.url })),
    ].slice(0, 6);

    const formatPriceTTC = (c: Candidate) => {
      if (typeof c.price === "number") {
        const ttc = htToTtc(c.price);
        return `${eur(ttc)} € TTC`;
      }
      return "Voir page produit";
    };

    const formatOneLine = (c: Candidate) => {
      const brand = c.brand_name ? ` de chez ${c.brand_name}` : "";
      const ref = c.sku ? ` ${c.sku}` : "";
      return `${c.name || "Produit"}${ref}${brand}`;
    };

    const productBlock = (label: string, c: Candidate) => {
      const lines = [
        `${label}`,
        `Nom : ${formatOneLine(c)}`,
        ...(typeof c.channels === "number" ? [`Canaux : ${c.channels}`] : []),
        `PoE : ${c.poe ? "oui" : "non"}`,
        `Prix : ${formatPriceTTC(c)}`,
        `Lien : ${c.url || "N/A"}`,
        ...(c.fiche_technique_url ? [`Fiche technique : ${c.fiche_technique_url}`] : []),
      ];
      return lines.join("\n");
    };

    const policy = `
RÈGLES STRICTES:
- Tu n'inventes JAMAIS de produits. Tu utilises UNIQUEMENT les produits listés ci-dessous.
- Tu n'inventes JAMAIS d'URL (produit ou fiche technique).
- Exclure totalement les produits AJAX.
- Prix: toujours afficher "€ TTC" (le prix fourni est HT, TTC = HT * 1.2).
- Format nom: "Nom + Référence + Marque" (ex: Enregistreur NVR 4 canaux DS-7604... de chez HIKVISION)

FORMAT:
1) ✅ Produit recommandé (si exact) OU ℹ️ Alternative proposée (si fallback)
2) Bloc enregistreur: 5-7 lignes max (Nom, Canaux si dispo, PoE, Prix TTC, Lien, FT si dispo)
3) Si le client demande aussi des caméras: proposer 3 caméras réelles (prix croissant) avec (Nom+Réf+Marque, Prix TTC, Lien, FT si dispo)
4) Terminer par 2-3 questions naturelles (caméras existantes, jours d’archives/HDD, résolution/4K, budget)
`.trim();

    const needSummary = `
BESOIN CLIENT:
- Enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- Caméras: ${need.wantsCamera ? "oui" : "non"}
- IP/NVR: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés: ${need.requestedChannels ?? "non précisé"}
`.trim();

    const exactBlock = picked.exact ? productBlock("✅ PRODUIT EXACT", picked.exact) : "";
    const fallbackBlock = picked.fallback ? productBlock("ℹ️ PRODUIT ALTERNATIF", picked.fallback) : "";

    const camerasBlock = cameraCandidates.length
      ? `\nCAMÉRAS À PROPOSER (prix croissant):\n${cameraCandidates
          .map((c, i) => {
            const ft = c.fiche_technique_url ? `\nFiche technique : ${c.fiche_technique_url}` : "";
            return [
              `${i + 1}) ${formatOneLine(c)}`,
              `Prix : ${formatPriceTTC(c)}`,
              `Lien : ${c.url || "N/A"}`,
              ft,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n")}`
      : "";

    const context = `
${policy}

${needSummary}

${exactBlock}
${fallbackBlock}
${camerasBlock}
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
      rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              sample_brand_map_size: brandMap.size,
              picked: {
                exact: picked.exact
                  ? {
                      id: picked.exact.id,
                      url: picked.exact.url,
                      channels: picked.exact.channels,
                      price_ht: picked.exact.price,
                      brand_name: picked.exact.brand_name,
                      fiche_technique_url: picked.exact.fiche_technique_url,
                    }
                  : null,
                fallback: picked.fallback
                  ? {
                      id: picked.fallback.id,
                      url: picked.fallback.url,
                      channels: picked.fallback.channels,
                      price_ht: picked.fallback.price,
                      brand_name: picked.fallback.brand_name,
                      fiche_technique_url: picked.fallback.fiche_technique_url,
                    }
                  : null,
              },
              recorder_candidates: recorderCandidates.slice(0, 6),
              camera_candidates: cameraCandidates,
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
