// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  debug?: boolean;
};

type ProductRow = {
  id: number;
  name: string | null;
  url: string | null;
  price: number | null; // HT ou TTC selon ta base -> on affiche TTC côté réponse si ton prix est déjà TTC
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  payload: any;
  brand: string | null; // option_id webflow (fabricants)
};

type CandidateBase = {
  id: number;
  name: string | null;
  url: string | null;
  price: number | null;
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  brand_option_id: string | null;
  brand_name: string | null;

  // debug
  min_variant_price?: number | null;
};

type RecorderCandidate = CandidateBase & {
  kind: "NVR" | "DVR" | "XVR" | "UNKNOWN";
  channels: number | null;
  poe: boolean;
  ip: boolean;
};

type CameraCandidate = CandidateBase & {
  kind: "IP" | "COAX" | "UNKNOWN";
  poe: boolean;
  mp: number | null; // mégapixels si détectable
  outdoor: boolean;
};

function normalizeText(v: any) {
  return (v ?? "").toString().trim();
}

function lc(v: any) {
  return normalizeText(v).toLowerCase();
}

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function extractBudgetEUR(input: string): number | null {
  const t = input.replace(/\s/g, "");
  // 1500€, 1500eur, 1.500€
  const m = t.match(/(\d{2,6})(?:[.,](\d{1,2}))?(?:€|eur)\b/i);
  if (!m) return null;
  const euros = Number(m[1]);
  const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  if (!Number.isFinite(euros)) return null;
  return euros + cents / 100;
}

function extractZones(input: string): number | null {
  const t = input.toLowerCase();
  // "5 zones"
  const m = t.match(/(\d{1,2})\s*zones?\b/i);
  if (m) return Number(m[1]);
  return null;
}

function detectNeed(input: string) {
  const t = input.toLowerCase();

  const wantsPack =
    t.includes("kit") ||
    t.includes("pack") ||
    t.includes("solution complète") ||
    t.includes("solution complete") ||
    t.includes("aucun cable") ||
    t.includes("aucun câble") ||
    t.includes("tout est a faire") ||
    t.includes("tout est à faire") ||
    t.includes("zones");

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsCamera =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsCoax = t.includes("coax") || t.includes("coaxial") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd");

  const wantsPoE = t.includes("poe");

  const zones = extractZones(input);
  const budget = extractBudgetEUR(input);

  const mChannels = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const requestedChannels = mChannels ? Number(mChannels[1]) : null;

  return {
    wantsPack,
    wantsRecorder,
    wantsCamera,
    wantsIP,
    wantsCoax,
    wantsPoE,
    zones: zones && zones > 0 ? zones : null,
    budget: budget && budget > 0 ? budget : null,
    requestedChannels: requestedChannels && requestedChannels > 0 ? requestedChannels : null,
  };
}

function detectRecorderKind(hay: string): "NVR" | "DVR" | "XVR" | "UNKNOWN" {
  const h = hay.toLowerCase();
  if (h.includes("xvr")) return "XVR";
  if (h.includes("dvr")) return "DVR";
  if (h.includes("nvr")) return "NVR";
  if (h.includes("enregistreur") && h.includes("ip")) return "NVR";
  return "UNKNOWN";
}

function detectCameraKind(hay: string, sku?: string | null, payload?: any): "IP" | "COAX" | "UNKNOWN" {
  const h = hay.toLowerCase();
  const s = (sku || "").toLowerCase();
  const tech = lc(payload?.technologie || payload?.technology || payload?.["technologie"]);
  const compat = lc(payload?.["compatibilite-camera"] || payload?.["compatibilité caméra"] || payload?.["compatibilite-camera"]);
  const alim = lc(payload?.["alimentation-de-la-camera"] || payload?.["alimentation"]);

  // Heuristiques fortes IP
  if (h.includes("ip") || h.includes("onvif") || compat.includes("onvif") || compat.includes("ip")) return "IP";
  if (s.startsWith("ds-2cd") || s.startsWith("ipc-")) return "IP";
  if (tech.includes("réseau") || tech.includes("reseau") || tech.includes("network")) return "IP";
  if (alim.includes("poe")) return "IP";

  // Heuristiques COAX
  if (h.includes("tvi") || h.includes("cvi") || h.includes("ahd") || h.includes("analog")) return "COAX";
  if (s.startsWith("ds-2ce")) return "COAX";

  return "UNKNOWN";
}

function detectCameraPoE(payload?: any, hay?: string): boolean {
  const alim = lc(payload?.["alimentation-de-la-camera"] || payload?.["alimentation"]);
  if (alim.includes("poe")) return true;
  const h = (hay || "").toLowerCase();
  if (h.includes("poe")) return true;
  return false;
}

function detectOutdoor(payload?: any, hay?: string): boolean {
  const ipRating = lc(payload?.["indice-de-protection"] || payload?.["indice de protection"] || payload?.["ip"]);
  const h = (hay || "").toLowerCase();
  if (ipRating.includes("ip66") || ipRating.includes("ip67") || ipRating.includes("ip68")) return true;
  if (h.includes("extérieur") || h.includes("exterieur") || h.includes("ip67") || h.includes("ip66")) return true;
  return false;
}

function extractMP(payload?: any, hay?: string): number | null {
  const res = lc(payload?.["resolution"] || payload?.["résolution"]);
  // "4 Mégapixels", "8MP", "2 MP"
  const m1 = res.match(/(\d{1,2})\s*mp\b/i) || res.match(/(\d{1,2})\s*m[ée]gap/i);
  if (m1) return Number(m1[1]);
  const h = (hay || "").toLowerCase();
  const m2 = h.match(/(\d{1,2})\s*mp\b/i);
  if (m2) return Number(m2[1]);
  return null;
}

function formatMoneyEUR(price: number | null, currency: string | null) {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return "Voir page produit";
  // affichage FR simple
  const v = price.toFixed(2).replace(".", ",");
  return `${v} € TTC`;
}

function pickBestRecorder(candidates: RecorderCandidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as RecorderCandidate | null, fallback: null as RecorderCandidate | null };

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

function pickPackRecorder(
  recorders: RecorderCandidate[],
  zones: number,
  wantsPoE: boolean,
  wantsIP: boolean
): RecorderCandidate | null {
  // cible : entre zones et 2*zones -> on choisit le plus proche au-dessus
  const minCh = zones;
  const maxCh = zones * 2;

  let pool = [...recorders];

  if (wantsIP) pool = pool.filter((r) => r.kind === "NVR" || r.ip);
  if (wantsPoE) pool = pool.filter((r) => r.poe);

  // Si pool vide, relâche PoE, puis relâche IP
  if (!pool.length && wantsPoE) pool = [...recorders].filter((r) => (wantsIP ? (r.kind === "NVR" || r.ip) : true));
  if (!pool.length) pool = [...recorders];

  // priorité : canaux >= minCh, le plus petit possible ; idéalement <= maxCh
  const sorted = pool
    .filter((r) => typeof r.channels === "number")
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  const within = sorted.find((r) => (r.channels as number) >= minCh && (r.channels as number) <= maxCh) ?? null;
  if (within) return within;

  const above = sorted.find((r) => (r.channels as number) >= minCh) ?? null;
  return above ?? (sorted[0] ?? null);
}

function pickCamerasForPack(
  cameras: CameraCandidate[],
  recorder: RecorderCandidate,
  zones: number,
  budget: number | null,
  wantsOutdoor: boolean,
  wantsPoE: boolean
) {
  // X à 2X caméras (zones -> X)
  const targetMin = zones;
  const targetMax = zones * 2;

  let pool = [...cameras];

  // compatibilité selon enregistreur
  if (recorder.kind === "NVR") {
    pool = pool.filter((c) => c.kind === "IP" || c.kind === "UNKNOWN");
  } else if (recorder.kind === "DVR") {
    pool = pool.filter((c) => c.kind === "COAX" || c.kind === "UNKNOWN");
  } else if (recorder.kind === "XVR") {
    // XVR accepte COAX + parfois IP (selon modèle) -> on autorise les deux
    pool = pool.filter((c) => c.kind !== "UNKNOWN" ? true : true);
  }

  if (wantsOutdoor) pool = pool.filter((c) => c.outdoor);

  // PoE (si demandé) : filtre strict
  if (wantsPoE) pool = pool.filter((c) => c.poe);

  // prix > 0 obligatoire (sinon ça fait des 0,00 € TTC)
  pool = pool.filter((c) => typeof c.price === "number" && Number.isFinite(c.price) && (c.price as number) > 0);

  // tri prix croissant
  pool.sort((a, b) => (a.price as number) - (b.price as number));

  // nombre à proposer : 3 par défaut (comme tu veux), mais logique pack : proposer 3 modèles (pas 10 lignes)
  const picks = pool.slice(0, 3);

  // calcul rapide si budget donné : combien on peut en prendre dans la fourchette X..2X
  let affordabilityNote: string | null = null;
  if (budget && picks.length) {
    const unit = picks[0].price as number;
    const maxUnits = Math.floor((budget / unit));
    const suggested = Math.max(targetMin, Math.min(targetMax, maxUnits));
    affordabilityNote =
      suggested >= targetMin
        ? `Avec ~${unit.toFixed(2).replace(".", ",")} € TTC / caméra (modèle le plus abordable), votre budget permet environ ${suggested} caméras (objectif ${targetMin} à ${targetMax}).`
        : `Votre budget semble serré pour ${targetMin} caméras : on peut ajuster la gamme (2MP/4MP) ou optimiser l’enregistreur/stockage.`;
  }

  return { picks, affordabilityNote };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;
    const input = (body.input || "").trim();
    if (!input) return Response.json({ ok: false, error: "Missing input" }, { status: 400 });

    const debug = !!body.debug;
    const conversationId = body.conversationId ?? crypto.randomUUID();

    const need = detectNeed(input);

    // ✅ FIX IMPORTANT : zones toujours number (supprime le number|null)
    const zones = typeof need.zones === "number" && need.zones > 0 ? need.zones : 5;

    const supa = supabaseAdmin();

    // 0) Load option map (fabricants) => option_id -> option_name
    const brandMap = new Map<string, string>();
    {
      const { data: optRows } = await supa
        .from("webflow_option_map")
        .select("field_slug,option_id,option_name")
        .eq("field_slug", "fabricants");

      if (Array.isArray(optRows)) {
        for (const r of optRows as any[]) {
          if (r?.option_id && r?.option_name) brandMap.set(String(r.option_id), String(r.option_name));
        }
      }
    }

    // 1) Load products
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload,brand")
      .limit(600);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows: ProductRow[] = Array.isArray(raw) ? (raw as any) : [];

    // 2) Min price per product from variants (fallback)
    const productIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
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

    // 3) Build candidates (exclude AJAX globally)
    const allCandidatesBase: CandidateBase[] = rows
      .map((r) => {
        const pid = Number(r.id);
        const minVar = minPriceByProductId.get(pid) ?? null;
        const finalPrice = typeof r.price === "number" ? r.price : (typeof minVar === "number" ? minVar : null);

        const brandOptionId = r.brand ? String(r.brand) : null;
        const brandName = brandOptionId ? (brandMap.get(brandOptionId) ?? null) : null;

        return {
          id: pid,
          name: r.name ?? (r.payload?.name ? String(r.payload.name) : null),
          url: r.url ?? null,
          price: finalPrice,
          currency: (r.currency || "EUR") as string | null,
          product_type: r.product_type ?? null,
          sku: r.sku ?? null,
          fiche_technique_url: r.fiche_technique_url ?? null,
          brand_option_id: brandOptionId,
          brand_name: brandName,
          min_variant_price: minVar,
        };
      })
      .filter((c) => {
        // ✅ exclusion AJAX complète (brand ou texte)
        const b = (c.brand_name || "").toUpperCase();
        const name = (c.name || "").toLowerCase();
        const sku = (c.sku || "").toLowerCase();
        if (b === "AJAX") return false;
        if (name.includes("ajax")) return false;
        if (sku.includes("ajax")) return false;
        return true;
      });

    // 4) Split recorders / cameras
    const recordersAll: RecorderCandidate[] = allCandidatesBase
      .map((c) => {
        const name = c.name || "";
        const pt = c.product_type || "";
        const hay = `${name} ${pt} ${c.sku || ""}`.toLowerCase();

        const kind = detectRecorderKind(hay);
        const channels = extractChannels(name) ?? extractChannels(hay);
        const poe = hay.includes("poe") || lc((rows.find(r=>Number(r.id)===c.id)?.payload)?.["ports-poe"] || "").includes("poe");
        const ip = kind === "NVR" || hay.includes("ip");

        return { ...c, kind, channels, poe, ip };
      })
      .filter((r) => {
        const t = (r.name || "").toLowerCase();
        const pt = (r.product_type || "").toLowerCase();
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

    const camerasAll: CameraCandidate[] = allCandidatesBase
      .map((c) => {
        const row = rows.find((r) => Number(r.id) === c.id);
        const payload = row?.payload;

        const name = c.name || "";
        const pt = c.product_type || "";
        const hay = `${name} ${pt} ${c.sku || ""}`.toLowerCase();

        const kind = detectCameraKind(hay, c.sku, payload);
        const poe = detectCameraPoE(payload, hay);
        const outdoor = detectOutdoor(payload, hay);
        const mp = extractMP(payload, hay);

        return { ...c, kind, poe, outdoor, mp };
      })
      .filter((cam) => {
        // heuristique caméra : product_type ou nom contient "caméra"
        const t = (cam.name || "").toLowerCase();
        const pt = (cam.product_type || "").toLowerCase();
        return t.includes("caméra") || t.includes("camera") || pt.includes("cam") || pt.includes("camera");
      });

    // 5) Decide mode : pack vs recorder-only
    const wantsOutdoor =
      input.toLowerCase().includes("extérieur") ||
      input.toLowerCase().includes("exterieur") ||
      input.toLowerCase().includes("dehors");

    let pickedRecorder: RecorderCandidate | null = null;
    let pickedCameras: CameraCandidate[] = [];

    if (need.wantsPack || (need.zones !== null) || (need.budget !== null && need.wantsCamera)) {
      // pack
      const wantsIP = need.wantsCoax ? false : true; // pack par défaut IP si pas coax explicit
      pickedRecorder = pickPackRecorder(recordersAll, zones, need.wantsPoE, wantsIP);

      if (pickedRecorder) {
        const camPick = pickCamerasForPack(
          camerasAll,
          pickedRecorder,
          zones,
          need.budget,
          wantsOutdoor,
          need.wantsPoE
        );
        pickedCameras = camPick.picks;
      }
    } else {
      // mode enregistreur "classique"
      let candidates = recordersAll;
      if (need.wantsIP) candidates = candidates.filter((c) => c.kind === "NVR" || c.ip);
      if (need.wantsCoax) candidates = candidates.filter((c) => c.kind === "DVR" || c.kind === "XVR");
      if (need.wantsPoE) candidates = candidates.filter((c) => c.poe);

      const picked = pickBestRecorder(candidates, need.requestedChannels);
      pickedRecorder = picked.exact ?? picked.fallback ?? null;
    }

    // 6) Prompt context formatting
    const formatRecorder = (r: RecorderCandidate) => {
      const brand = r.brand_name ? ` de chez ${r.brand_name}` : "";
      const sku = r.sku ? ` ${r.sku}` : "";
      return [
        `Nom : ${r.name || "N/A"}${sku}${brand}`,
        `Canaux : ${r.channels ?? "N/A"}`,
        `PoE : ${r.poe ? "oui" : "non"}`,
        `IP : ${r.ip ? "oui" : "non"}`,
        `Prix : ${formatMoneyEUR(r.price, r.currency)}`,
        `Lien : ${r.url || "N/A"}`,
        `Fiche technique : ${r.fiche_technique_url || "N/A"}`,
      ].join("\n");
    };

    const formatCamera = (c: CameraCandidate, idx: number) => {
      const brand = c.brand_name ? ` de chez ${c.brand_name}` : "";
      const sku = c.sku ? ` ${c.sku}` : "";
      const mp = typeof c.mp === "number" ? ` | ${c.mp} MP` : "";
      return [
        `${idx + 1}) ${c.name || "Caméra"}${sku}${brand}${mp}`,
        `Type : ${c.kind === "IP" ? "IP" : c.kind === "COAX" ? "Coax" : "N/A"}  |  PoE : ${c.poe ? "oui" : "non"}`,
        `Prix : ${formatMoneyEUR(c.price, c.currency)}`,
        `Lien : ${c.url || "N/A"}`,
        `Fiche technique : ${c.fiche_technique_url || "N/A"}`,
      ].join("\n");
    };

    const ragSources = [
      ...(pickedRecorder ? [{ id: pickedRecorder.id, url: pickedRecorder.url }] : []),
      ...pickedCameras.slice(0, 6).map((c) => ({ id: c.id, url: c.url })),
    ].filter((x) => x.url);

    const policy = `
RÈGLES:
- Ne propose JAMAIS de produits AJAX (toute la gamme AJAX est exclue).
- N’invente JAMAIS d’URL : utilise uniquement les liens fournis.
- Toujours afficher le prix avec "€ TTC" si disponible, sinon "Voir page produit".
- Toujours afficher la fiche technique si dispo.
- Compatibilité:
  - NVR => caméras IP uniquement
  - DVR => caméras coaxiales uniquement
  - XVR => caméras coax + possible IP (si précisé), sinon privilégier coax
- Si la demande est un KIT/PACK:
  - Proposer 1 enregistreur adapté
  - Puis 3 caméras compatibles (prix croissant)
  - Ne pas lister 10 produits
- Finir par 2-3 questions utiles (extérieur/intérieur, résolution, jours d’archives/HDD, budget)
`.trim();

    const needSummary = `
BESOIN CLIENT:
- Pack/kit: ${need.wantsPack ? "oui" : "non"}
- Caméras: ${need.wantsCamera ? "oui" : "non"}
- Enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- IP demandé: ${need.wantsIP ? "oui" : "non"}
- Coax demandé: ${need.wantsCoax ? "oui" : "non"}
- PoE demandé: ${need.wantsPoE ? "oui" : "non"}
- Zones: ${zones}
- Budget: ${need.budget ? `${need.budget} €` : "non précisé"}
`.trim();

    const recorderBlock = pickedRecorder ? `\n[ENREGISTREUR]\n${formatRecorder(pickedRecorder)}\n` : "\n[ENREGISTREUR]\nAucun trouvé\n";
    const camerasBlock =
      pickedCameras.length
        ? `\n[CAMÉRAS COMPATIBLES]\n${pickedCameras.map((c, i) => formatCamera(c, i)).join("\n\n")}\n`
        : `\n[CAMÉRAS COMPATIBLES]\nAucune caméra compatible trouvée (prix manquant ou données insuffisantes).\n`;

    const context = `
${policy}

${needSummary}
${recorderBlock}
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
              counts: {
                camerasAll: camerasAll.length,
                recordersAll: recordersAll.length,
                pickedCameras: pickedCameras.length,
              },
              sampleCameras: camerasAll.slice(0, 5),
              pickedRecorder: pickedRecorder ? { id: pickedRecorder.id, sku: pickedRecorder.sku, kind: pickedRecorder.kind } : null,
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
