// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  debug?: boolean;
};

type RowProduct = {
  id: number;
  name: string | null;
  url: string | null;
  price: number | null; // HT stocké
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url?: string | null;
  payload?: any;
};

type Candidate = {
  id: number;
  name: string | null;
  url: string | null;

  sku: string | null;
  product_type: string | null;

  // Fabricant
  brand_id: string | null;   // ID option Webflow (payload.fabricants)
  brand_name: string | null; // "DAHUA", "HIKVISION", "AJAX", etc.

  // Prix
  price_ht: number | null;
  price_ttc: number | null;
  currency: string | null;

  fiche_technique_url: string | null;

  // Heuristiques
  channels: number | null;
  poe: boolean;
  isRecorder: boolean;
  isNvr: boolean;
  isDvr: boolean;
  isXvr: boolean;
  isIpCamera: boolean;
  isAnalogCamera: boolean;

  // debug
  min_variant_price_ht?: number | null;
};

const VAT_RATE = 0.2;

function toTTC(ht: number | null): number | null {
  if (typeof ht !== "number" || !Number.isFinite(ht)) return null;
  return Math.round(ht * (1 + VAT_RATE) * 100) / 100;
}

function moneyFR(n: number): string {
  // format 135.24 -> "135,24"
  return n.toFixed(2).replace(".", ",");
}

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function detectNeed(input: string) {
  const t = (input || "").toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsCamera =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsPoE = t.includes("poe");

  const wantsCoax =
    t.includes("coax") || t.includes("coaxial") || t.includes("tvi") || t.includes("ahd") || t.includes("cvi");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const channels = m ? Number(m[1]) : null;

  return {
    wantsRecorder,
    wantsCamera,
    wantsIP,
    wantsPoE,
    wantsCoax,
    requestedChannels: channels && channels > 0 ? channels : null,
  };
}

// Déduit un "type" depuis le nom/sku/product_type/payload
function analyzeTextFlags(name: string, sku: string, productType: string, payload: any) {
  const hay = `${name} ${sku} ${productType} ${JSON.stringify(payload || {})}`.toLowerCase();

  const isNvr =
    hay.includes(" nvr") ||
    hay.includes("enregistreur nvr") ||
    hay.includes('"type-enregistreur":"nvr"') ||
    hay.includes("network video recorder");

  const isDvr =
    hay.includes(" dvr") ||
    hay.includes("enregistreur dvr") ||
    hay.includes("digital video recorder");

  const isXvr =
    hay.includes(" xvr") ||
    hay.includes("enregistreur xvr");

  // IP camera heuristique
  const isIpCamera =
    hay.includes("caméra ip") ||
    hay.includes("camera ip") ||
    hay.includes("réseau") ||
    hay.includes("network") ||
    hay.includes("onvif") ||
    /^ds-2cd/i.test((sku || "").trim()) ||
    /\bipc\b/i.test(hay);

  // Analog camera heuristique
  const isAnalogCamera =
    hay.includes("tvi") ||
    hay.includes("ahd") ||
    hay.includes("cvi") ||
    hay.includes("hdcvi") ||
    hay.includes("coax") ||
    /^ds-2ce/i.test((sku || "").trim()) ||
    /\bhac\b/i.test(hay);

  const isRecorder = hay.includes("enregistreur") || isNvr || isDvr || isXvr;

  const poe = hay.includes("poe");

  return { isRecorder, isNvr, isDvr, isXvr, isIpCamera, isAnalogCamera, poe };
}

// Choix enregistreur: exact channels si possible, sinon le plus petit au-dessus
function pickBestRecorder(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  const sortedByChannels = [...candidates].sort((a, b) => (a.channels ?? 9999) - (b.channels ?? 9999));

  if (!requestedChannels) return { exact: sortedByChannels[0] ?? null, fallback: null };

  const exact = candidates.find((c) => c.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = candidates
    .filter((c) => typeof c.channels === "number" && (c.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

// Mapping optionId -> optionName via table webflow_item_map (field_slug='fabricants')
async function loadBrandMap() {
  const supa = supabaseAdmin();

  const { data, error } = await supa
    .from("webflow_item_map")
    .select("field_slug, option_id, option_name")
    .eq("field_slug", "fabricants")
    .limit(500);

  if (error || !Array.isArray(data)) return new Map<string, string>();

  const m = new Map<string, string>();
  for (const r of data as any[]) {
    if (r?.option_id && r?.option_name) m.set(String(r.option_id), String(r.option_name));
  }
  return m;
}

async function loadMinVariantPrices(productIds: number[]) {
  const supa = supabaseAdmin();
  const map = new Map<number, number>();

  if (!productIds.length) return map;

  const { data, error } = await supa
    .from("product_variants")
    .select("product_id,price")
    .in("product_id", productIds);

  if (error || !Array.isArray(data)) return map;

  for (const v of data as any[]) {
    const pid = Number(v.product_id);
    const p = typeof v.price === "number" ? v.price : null;
    if (!Number.isFinite(pid) || p === null) continue;
    const prev = map.get(pid);
    if (prev === undefined || p < prev) map.set(pid, p);
  }

  return map;
}

function rowToCandidate(row: RowProduct, brandMap: Map<string, string>, minPriceById: Map<number, number>): Candidate {
  const pid = Number(row.id);
  const name = (row.name || row.payload?.name || "").toString();
  const sku = (row.sku || row.payload?.["product-reference"] || row.payload?.["product_reference"] || "").toString();
  const productType = (row.product_type || "").toString();
  const payload = row.payload || {};

  const brandId = (payload?.fabricants || payload?.fabricant || null) ? String(payload?.fabricants || payload?.fabricant) : null;
  const brandName = brandId ? (brandMap.get(brandId) || null) : null;

  const flags = analyzeTextFlags(name, sku, productType, payload);
  const channels = extractChannels(name);

  const minVar = minPriceById.get(pid) ?? null;
  const finalHT =
    typeof row.price === "number" ? row.price : (typeof minVar === "number" ? minVar : null);

  const finalTTC = toTTC(finalHT);

  return {
    id: pid,
    name: name || null,
    url: row.url || null,
    sku: sku || null,
    product_type: productType || null,
    brand_id: brandId,
    brand_name: brandName,
    price_ht: finalHT,
    price_ttc: finalTTC,
    currency: row.currency || "EUR",
    fiche_technique_url: (row.fiche_technique_url || payload?.["fiche-technique-du-produit"]?.url || null) ?? null,
    channels,
    poe: flags.poe,
    isRecorder: flags.isRecorder,
    isNvr: flags.isNvr,
    isDvr: flags.isDvr,
    isXvr: flags.isXvr,
    isIpCamera: flags.isIpCamera,
    isAnalogCamera: flags.isAnalogCamera,
    min_variant_price_ht: minVar,
  };
}

function formatOneLineProduct(c: Candidate) {
  const brand = c.brand_name ? ` de chez ${c.brand_name}` : "";
  const sku = c.sku ? ` ${c.sku}` : "";
  const name = (c.name || "").trim() || "Produit";
  const title = `${name}${sku}${brand}`.trim();

  const price = typeof c.price_ttc === "number" ? `${moneyFR(c.price_ttc)} € TTC` : "Voir page produit";
  const link = c.url ? c.url : "N/A";
  const ft = c.fiche_technique_url ? c.fiche_technique_url : null;

  return { title, price, link, ft };
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
    const brandMap = await loadBrandMap();

    // =========================
    // 1) Charger candidats enregistreurs (ciblé)
    // =========================
    // On évite les full scan et on limite fort.
    const { data: recRaw, error: recErr } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .or("name.ilike.%enregistreur%,name.ilike.%nvr%,name.ilike.%dvr%,name.ilike.%xvr%,sku.ilike.%NVR%,sku.ilike.%DVR%,sku.ilike.%XVR%")
      .limit(120);

    if (recErr) {
      return Response.json({ ok: false, error: "Supabase query failed", details: recErr.message }, { status: 500 });
    }

    const recRows = (Array.isArray(recRaw) ? recRaw : []) as RowProduct[];
    const recIds = recRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    const recMinPrice = await loadMinVariantPrices(recIds);

    let recorderCandidates = recRows.map((r) => rowToCandidate(r, brandMap, recMinPrice));

    // Exclure AJAX globalement
    recorderCandidates = recorderCandidates.filter((c) => (c.brand_name || "").toUpperCase() !== "AJAX");

    // Ne garder que les "recorders"
    recorderCandidates = recorderCandidates.filter((c) => c.isRecorder);

    // Filtre IP/PoE selon demande
    if (need.wantsPoE) recorderCandidates = recorderCandidates.filter((c) => c.poe);

    // Si l’utilisateur exprime IP (ou NVR), on préfère NVR
    if (need.wantsIP) recorderCandidates = recorderCandidates.filter((c) => c.isNvr || (String(c.name || "").toLowerCase().includes("nvr")));

    // Si l’utilisateur exprime coax, on préfère DVR/XVR
    if (need.wantsCoax) recorderCandidates = recorderCandidates.filter((c) => c.isDvr || c.isXvr);

    // Choix du recorder
    const picked = pickBestRecorder(recorderCandidates, need.requestedChannels);
    const chosenRecorder = picked.exact || picked.fallback;

    // Si aucun recorder trouvé => on répond proprement
    if (!chosenRecorder) {
      const msg = `Je n’ai pas trouvé d’enregistreur correspondant dans le catalogue CamProtect.
Pouvez-vous préciser :
- IP (NVR) ou coaxial (DVR/XVR) ?
- nombre de caméras (4 / 8 / 16…) ?
- PoE obligatoire ou non ?`;
      return Response.json({
        ok: true,
        conversationId,
        reply: msg,
        rag: { used: 0, sources: [] },
        ...(debug ? { debug: { need, picked: null, recorderCandidates: recorderCandidates.slice(0, 6) } } : {}),
      });
    }

    // =========================
    // 2) Déterminer type attendu de caméras selon recorder
    // =========================
    const recorderIsNvr = chosenRecorder.isNvr || (!chosenRecorder.isDvr && !chosenRecorder.isXvr && need.wantsIP);
    const expectIpCameras = recorderIsNvr;
    const expectAnalogCameras = !recorderIsNvr;

    // =========================
    // 3) Charger candidats caméras (ciblé) + compatibilité
    // =========================
    // On charge seulement si besoin caméra OU si la demande inclut "caméras"
    // (sinon on ne fait pas perdre du temps au serveur)
    let cameraCandidates: Candidate[] = [];
    if (need.wantsCamera || input.toLowerCase().includes("caméra") || input.toLowerCase().includes("camera")) {
      const { data: camRaw, error: camErr } = await supa
        .from("products")
        .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
        .or("name.ilike.%cam%,name.ilike.%dome%,name.ilike.%bullet%,name.ilike.%turret%,sku.ilike.%DS-2C%,sku.ilike.%IPC%,sku.ilike.%HAC%")
        .limit(200);

      if (!camErr) {
        const camRows = (Array.isArray(camRaw) ? camRaw : []) as RowProduct[];
        const camIds = camRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
        const camMinPrice = await loadMinVariantPrices(camIds);

        cameraCandidates = camRows.map((r) => rowToCandidate(r, brandMap, camMinPrice));
        cameraCandidates = cameraCandidates.filter((c) => (c.brand_name || "").toUpperCase() !== "AJAX");

        // compat selon recorder :
        if (expectIpCameras) {
          cameraCandidates = cameraCandidates.filter((c) => c.isIpCamera && !c.isAnalogCamera);
        } else {
          cameraCandidates = cameraCandidates.filter((c) => c.isAnalogCamera);
        }

        // supprimer prix = 0 / null (éviter la caméra à 0€)
        cameraCandidates = cameraCandidates.filter((c) => typeof c.price_ttc === "number" && (c.price_ttc as number) > 0);

        // tri par prix croissant
        cameraCandidates.sort((a, b) => (a.price_ttc as number) - (b.price_ttc as number));

        // limiter à 3 propositions max
        cameraCandidates = cameraCandidates.slice(0, 3);
      }
    }

    // =========================
    // 4) Construire contexte LLM + règles strictes de rendu
    // =========================
    const recFmt = formatOneLineProduct(chosenRecorder);
    const recStatus =
      picked.exact ? "✅ Produit recommandé" : "ℹ️ Alternative proposée";

    const missingExplain =
      !picked.exact && need.requestedChannels
        ? `Nous n’avons pas d’enregistreur exactement en ${need.requestedChannels} canaux correspondant à tous vos critères ; voici la meilleure alternative au-dessus.`
        : "";

    const camerasBlock = cameraCandidates.length
      ? cameraCandidates
          .map((c, idx) => {
            const f = formatOneLineProduct(c);
            return [
              `${idx + 1}) ${f.title}`,
              `   Prix : ${f.price}`,
              `   Lien : ${f.link}`,
              f.ft ? `   Fiche technique : ${f.ft}` : null,
            ].filter(Boolean).join("\n");
          })
          .join("\n")
      : "";

    const compatSentence = expectIpCameras
      ? "Compatibilité : cet enregistreur est NVR (IP). Proposer uniquement des caméras IP."
      : "Compatibilité : cet enregistreur est DVR/XVR (coaxial). Proposer uniquement des caméras analogiques (TVI/CVI/AHD…).";

    const policy = `
RÈGLES DE RÉPONSE:
- Ne JAMAIS inventer de lien. Utiliser uniquement les liens fournis.
- Exclure TOUT produit AJAX (marque AJAX).
- Toujours afficher les PRIX en TTC (TVA 20%).
- Si on propose une alternative (canaux supérieurs), l’expliquer clairement (on a compris la demande).
- Si caméras demandées, proposer 3 caméras compatibles (prix croissant), chacune avec: nom+ref+marque, prix TTC, lien, FT si dispo.
- Ton: commercial pro, clair, pas de liste "1/2/3" brute ; préférer 2-3 questions ciblées en fin.
`.trim();

    const context = `
${policy}

BESOIN CLIENT:
- Enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- Caméras: ${need.wantsCamera ? "oui" : "non"}
- IP/NVR: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés: ${need.requestedChannels ?? "non précisé"}

${compatSentence}

ENREGISTREUR À PRÉSENTER:
${recStatus}
${missingExplain ? `Note: ${missingExplain}` : ""}
Nom : ${recFmt.title}
Prix : ${recFmt.price}
Lien : ${recFmt.link}
${recFmt.ft ? `Fiche technique : ${recFmt.ft}` : ""}

${cameraCandidates.length ? `CAMÉRAS COMPATIBLES (prix croissant):\n${camerasBlock}` : `CAMÉRAS COMPATIBLES: aucune proposition trouvée (ne pas inventer).`}
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: context },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    // sources RAG (debug UI)
    const sources = [
      { id: chosenRecorder.id, url: chosenRecorder.url },
      ...cameraCandidates.map((c) => ({ id: c.id, url: c.url })),
    ].filter((s) => !!s.url);

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: sources.length ? 1 : 0, sources },
      ...(debug
        ? {
            debug: {
              need,
              picked: {
                exact: picked.exact ? { id: picked.exact.id, url: picked.exact.url, channels: picked.exact.channels } : null,
                fallback: picked.fallback ? { id: picked.fallback.id, url: picked.fallback.url, channels: picked.fallback.channels } : null,
              },
              recorder: chosenRecorder,
              cameras: cameraCandidates,
              expectIpCameras,
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
