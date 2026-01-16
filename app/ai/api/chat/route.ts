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

  // HT (Webflow price = HT chez toi)
  price_ht: number | null;
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

// ⚠️ Ajuste si besoin (selon ton host)
const AI_TIMEOUT_MS = 8500;

// Cache brand options (évite un call DB à chaque requête)
let BRAND_CACHE: { map: Map<string, string>; fetchedAt: number } | null = null;
const BRAND_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function eur(n: number) {
  return n.toFixed(2).replace(".", ",");
}
function htToTtc(ht: number) {
  return ht * (1 + VAT_RATE);
}

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
    t.includes("caméra") ||
    t.includes("caméras") ||
    t.includes("camera") ||
    t.includes("cameras");

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

function looksLikeRecorderRow(name: string, productType: string, sku: string) {
  const hay = `${name} ${productType} ${sku}`.toLowerCase();
  return hay.includes("enregistreur") || hay.includes("nvr") || hay.includes("dvr") || hay.includes("xvr");
}

function looksLikeCameraRow(name: string, productType: string, sku: string) {
  const hay = `${name} ${productType} ${sku}`.toLowerCase();
  return (
    hay.includes("caméra") ||
    hay.includes("camera") ||
    hay.includes("bullet") ||
    hay.includes("dôme") ||
    hay.includes("dome")
  );
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

function formatOneLine(c: Candidate) {
  const brand = c.brand_name ? ` de chez ${c.brand_name}` : "";
  const ref = c.sku ? ` ${c.sku}` : "";
  return `${c.name || "Produit"}${ref}${brand}`;
}

function formatPriceTTC(c: Candidate) {
  if (typeof c.price_ht === "number") {
    const ttc = htToTtc(c.price_ht);
    return `${eur(ttc)} € TTC`;
  }
  return "Voir page produit";
}

function deterministicReply(picked: { exact: Candidate | null; fallback: Candidate | null }, cams: Candidate[]) {
  const chosen = picked.exact ?? picked.fallback;
  if (!chosen) {
    return `Je n’ai pas trouvé d’enregistreur correspondant dans le catalogue.\n\nPouvez-vous préciser : IP ou coaxial (DVR/XVR), nombre de caméras, PoE ou non ?`;
  }

  const header = picked.exact ? "✅ Produit recommandé" : "ℹ️ Alternative proposée";

  const lines: string[] = [];
  lines.push(header);
  lines.push(`Nom : ${formatOneLine(chosen)}`);
  if (typeof chosen.channels === "number") lines.push(`Canaux : ${chosen.channels}`);
  lines.push(`PoE : ${chosen.poe ? "oui" : "non"}`);
  lines.push(`Prix : ${formatPriceTTC(chosen)}`);
  if (chosen.url) lines.push(`Lien : ${chosen.url}`);
  if (chosen.fiche_technique_url) lines.push(`Fiche technique : ${chosen.fiche_technique_url}`);

  if (cams.length) {
    lines.push("");
    lines.push("Caméras compatibles proposées (prix croissant) :");
    cams.slice(0, 3).forEach((c, i) => {
      lines.push(`${i + 1}) ${formatOneLine(c)}`);
      lines.push(`   Prix : ${formatPriceTTC(c)}`);
      if (c.url) lines.push(`   Lien : ${c.url}`);
      if (c.fiche_technique_url) lines.push(`   Fiche technique : ${c.fiche_technique_url}`);
    });
  }

  lines.push("");
  lines.push("Pour affiner :");
  lines.push("- Vous visez plutôt 1080p, 4MP ou 8MP (4K) ?");
  lines.push("- Combien de jours d’archives souhaitez-vous (et HDD déjà prévu ou non) ?");
  lines.push("- Installation : distances importantes / extérieur (IP67) / besoin micro ?");

  return lines.join("\n");
}

async function getBrandMap(supa: ReturnType<typeof supabaseAdmin>) {
  const now = Date.now();
  if (BRAND_CACHE && now - BRAND_CACHE.fetchedAt < BRAND_CACHE_TTL_MS) return BRAND_CACHE.map;

  const map = new Map<string, string>();
  const { data } = await supa
    .from("webflow_option_map")
    .select("option_id, option_name")
    .eq("field_slug", "fabricants")
    .limit(500);

  if (Array.isArray(data)) {
    for (const o of data as any[]) {
      if (o?.option_id && o?.option_name) map.set(String(o.option_id), String(o.option_name));
    }
  }

  BRAND_CACHE = { map, fetchedAt: now };
  return map;
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
    const brandMap = await getBrandMap(supa);

    // ⚡ Requêtes ciblées (au lieu de charger tout le catalogue)
    // 1) Enregistreurs
    const recorderOr = [
      "name.ilike.%nvr%",
      "name.ilike.%dvr%",
      "name.ilike.%xvr%",
      "name.ilike.%enregistreur%",
      "product_type.ilike.%nvr%",
      "product_type.ilike.%dvr%",
      "product_type.ilike.%xvr%",
    ].join(",");

    // 2) Caméras
    const cameraOr = [
      "name.ilike.%caméra%",
      "name.ilike.%camera%",
      "name.ilike.%bullet%",
      "name.ilike.%dôme%",
      "name.ilike.%dome%",
      "product_type.ilike.%cam%",
      "product_type.ilike.%camera%",
    ].join(",");

    // Charge enregistreurs si nécessaire (ou par défaut si la demande est vague)
    const shouldLoadRecorders = need.wantsRecorder || need.wantsIP || need.wantsPoE || need.requestedChannels !== null;

    const recorderRows: any[] = [];
    if (shouldLoadRecorders) {
      const { data, error } = await supa
        .from("products")
        .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,brand,payload")
        .or(recorderOr)
        .limit(220);

      if (error) {
        return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
      }
      if (Array.isArray(data)) recorderRows.push(...data);
    }

    // Charge caméras seulement si demandé
    const cameraRows: any[] = [];
    if (need.wantsCamera) {
      const { data, error } = await supa
        .from("products")
        .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,brand,payload")
        .or(cameraOr)
        .limit(260);

      if (error) {
        return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
      }
      if (Array.isArray(data)) cameraRows.push(...data);
    }

    const toCandidate = (r: any): Candidate => {
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
        price_ht: typeof r.price === "number" ? r.price : null,
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
    };

    // ✅ exclure AJAX partout
    const recorderCandidatesAll = recorderRows
      .map(toCandidate)
      .filter((c) => (c.brand_name || "").toUpperCase() !== "AJAX")
      .filter((c) => looksLikeRecorderRow(c.name || "", c.product_type || "", c.sku || ""));

    let recorderCandidates = recorderCandidatesAll;
    if (need.wantsIP) recorderCandidates = recorderCandidates.filter((c) => c.ip);
    if (need.wantsPoE) recorderCandidates = recorderCandidates.filter((c) => c.poe);

    if (!recorderCandidates.length && need.wantsIP) {
      recorderCandidates = recorderCandidatesAll.filter((c) => c.ip);
    }
    if (!recorderCandidates.length) {
      recorderCandidates = recorderCandidatesAll;
    }

    const picked = pickBestRecorder(recorderCandidates, need.requestedChannels);

    const cameraCandidates = cameraRows
      .map(toCandidate)
      .filter((c) => (c.brand_name || "").toUpperCase() !== "AJAX")
      .filter((c) => looksLikeCameraRow(c.name || "", c.product_type || "", c.sku || ""))
      .filter((c) => typeof c.price_ht === "number" && !!c.url)
      .sort((a, b) => (a.price_ht as number) - (b.price_ht as number))
      .slice(0, 3);

    const ragSources = [
      ...(picked.exact ? [{ id: picked.exact.id, url: picked.exact.url }] : []),
      ...(picked.fallback ? [{ id: picked.fallback.id, url: picked.fallback.url }] : []),
      ...cameraCandidates.map((c) => ({ id: c.id, url: c.url })),
    ].slice(0, 6);

    // === CONTEXTE IA (très compact) ===
    const policy = `
RÈGLES:
- N’invente aucun produit/URL. Utilise uniquement les produits fournis.
- Exclure totalement AJAX.
- Prix: afficher toujours en € TTC (prix fourni = HT, TTC = HT*1.2).
- Nom: "Nom + Référence + Marque" (ex: Enregistreur NVR 4 canaux DHI-... de chez DAHUA)
- Si caméras demandées: proposer 3 caméras réelles (prix croissant) avec prix TTC, lien, FT si dispo.
- Finir par 2-3 questions naturelles (HDD/jours, résolution, contexte pose).
`.trim();

    const context = `
${policy}

BESOIN:
- Caméras demandées: ${need.wantsCamera ? "oui" : "non"}
- IP/NVR: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux: ${need.requestedChannels ?? "non précisé"}

ENREGISTREUR EXACT:
${picked.exact ? JSON.stringify(picked.exact) : "null"}

ENREGISTREUR ALTERNATIF:
${picked.fallback ? JSON.stringify(picked.fallback) : "null"}

CAMÉRAS (max 3):
${cameraCandidates.length ? JSON.stringify(cameraCandidates) : "[]"}
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: context },
      { role: "user" as const, content: input },
    ];

    // === TIMEOUT HARD autour de l'IA ===
    const aiPromise = chatCompletion(messages);

    const reply = await Promise.race<string | null>([
      aiPromise.then((r) => r),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_TIMEOUT_MS)),
    ]);

    // Fallback sans IA si timeout → évite 504
    const finalReply = reply ?? deterministicReply(picked, cameraCandidates);

    return Response.json({
      ok: true,
      conversationId,
      reply: finalReply,
      rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              brand_cache_size: brandMap.size,
              picked: {
                exact: picked.exact
                  ? {
                      id: picked.exact.id,
                      sku: picked.exact.sku,
                      brand: picked.exact.brand_name,
                      price_ht: picked.exact.price_ht,
                      fiche_technique_url: picked.exact.fiche_technique_url,
                    }
                  : null,
                fallback: picked.fallback
                  ? {
                      id: picked.fallback.id,
                      sku: picked.fallback.sku,
                      brand: picked.fallback.brand_name,
                      price_ht: picked.fallback.price_ht,
                      fiche_technique_url: picked.fallback.fiche_technique_url,
                    }
                  : null,
              },
              recorder_candidates_count: recorderCandidates.length,
              camera_candidates: cameraCandidates,
              ai_timed_out: reply === null,
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
