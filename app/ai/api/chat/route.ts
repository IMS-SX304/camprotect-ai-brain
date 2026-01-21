// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
  price: number | null; // HT (souvent vide si prix via variantes)
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  payload: any;
  brand: string | null; // option id "fabricants"
};

type CandidateBase = {
  id: number;
  name: string | null;
  url: string | null;
  price_ttc: number | null;
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  brand_option_id: string | null;
  brand_name: string | null;

  // debug
  price_ht_final?: number | null;
  min_variant_price?: number | null;
};

type RecorderKind = "NVR" | "DVR" | "XVR" | "UNKNOWN";
type CameraKind = "IP" | "COAX" | "UNKNOWN";

type RecorderCandidate = CandidateBase & {
  kind: RecorderKind;
  channels: number | null;
  poe: boolean;
  ip: boolean;
};

type CameraCandidate = CandidateBase & {
  kind: CameraKind;
  poe: boolean;
  mp: number | null;
  outdoor: boolean;
};

// ---------------- utils ----------------
function normalizeText(v: any) {
  return (v ?? "").toString().trim();
}
function lc(v: any) {
  return normalizeText(v).toLowerCase();
}

function priceHtToTtc(priceHt: number | null) {
  if (typeof priceHt !== "number" || !Number.isFinite(priceHt) || priceHt <= 0) return null;
  return Math.round(priceHt * 1.2 * 100) / 100;
}
function formatMoneyEUR_TTC(priceTtc: number | null) {
  if (typeof priceTtc !== "number" || !Number.isFinite(priceTtc) || priceTtc <= 0) return "Voir page produit";
  return `${priceTtc.toFixed(2).replace(".", ",")} € TTC`;
}

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function extractZones(input: string): number | null {
  const t = input.toLowerCase();
  const m = t.match(/(\d{1,2})\s*zones?\b/i);
  if (m) return Number(m[1]);
  return null;
}

function extractBudgetEUR(input: string): number | null {
  const t = input.replace(/\s/g, "");
  const m = t.match(/(\d{2,6})(?:[.,](\d{1,2}))?(?:€|eur)\b/i);
  if (!m) return null;
  const euros = Number(m[1]);
  const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  if (!Number.isFinite(euros)) return null;
  return euros + cents / 100;
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

  const wantsRecorder = t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");
  const wantsCamera = t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsCoax =
    t.includes("coax") || t.includes("coaxial") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd");
  const wantsPoE = t.includes("poe");

  const zones = extractZones(input);
  const budget = extractBudgetEUR(input);

  const mChannels = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const requestedChannels = mChannels ? Number(mChannels[1]) : null;

  const wantsOutdoor = t.includes("extérieur") || t.includes("exterieur") || t.includes("dehors");

  return {
    wantsPack,
    wantsRecorder,
    wantsCamera,
    wantsIP,
    wantsCoax,
    wantsPoE,
    wantsOutdoor,
    zones: zones && zones > 0 ? zones : null,
    budget: budget && budget > 0 ? budget : null,
    requestedChannels: requestedChannels && requestedChannels > 0 ? requestedChannels : null,
  };
}

function detectRecorderKind(hay: string): RecorderKind {
  const h = hay.toLowerCase();
  if (h.includes("xvr")) return "XVR";
  if (h.includes("dvr")) return "DVR";
  if (h.includes("nvr")) return "NVR";
  if (h.includes("enregistreur") && h.includes("ip")) return "NVR";
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
  const m1 = res.match(/(\d{1,2})\s*mp\b/i) || res.match(/(\d{1,2})\s*m[ée]gap/i);
  if (m1) return Number(m1[1]);
  const h = (hay || "").toLowerCase();
  const m2 = h.match(/(\d{1,2})\s*mp\b/i);
  if (m2) return Number(m2[1]);
  return null;
}

function detectCameraKindFromSku(sku: string | null): CameraKind {
  const s = (sku || "").toLowerCase();
  if (s.startsWith("ds-2cd") || s.startsWith("ipc-")) return "IP";
  if (s.startsWith("ds-2ce")) return "COAX";
  return "UNKNOWN";
}

function pickBestRecorder(recorders: RecorderCandidate[], requestedChannels: number | null) {
  if (!recorders.length) return { exact: null as RecorderCandidate | null, fallback: null as RecorderCandidate | null };

  if (!requestedChannels) {
    const sorted = [...recorders].sort((a, b) => (a.channels ?? 9999) - (b.channels ?? 9999));
    return { exact: sorted[0] ?? null, fallback: null };
  }

  const exact = recorders.find((r) => r.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = recorders
    .filter((r) => typeof r.channels === "number" && (r.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

function pickPackRecorder(recorders: RecorderCandidate[], zones: number, wantsPoE: boolean, wantsIP: boolean) {
  const minCh = zones;
  const maxCh = zones * 2;

  let pool = [...recorders];
  if (wantsIP) pool = pool.filter((r) => r.kind === "NVR" || r.ip);
  if (wantsPoE) pool = pool.filter((r) => r.poe);

  if (!pool.length && wantsPoE) pool = [...recorders].filter((r) => (wantsIP ? r.kind === "NVR" || r.ip : true));
  if (!pool.length) pool = [...recorders];

  const sorted = pool
    .filter((r) => typeof r.channels === "number")
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  const within = sorted.find((r) => (r.channels as number) >= minCh && (r.channels as number) <= maxCh) ?? null;
  if (within) return within;

  const above = sorted.find((r) => (r.channels as number) >= minCh) ?? null;
  return above ?? (sorted[0] ?? null);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function pickCamerasForRecorder(
  cameras: CameraCandidate[],
  recorder: RecorderCandidate,
  camCount: number,
  budget: number | null,
  wantsOutdoor: boolean,
  wantsPoE: boolean
) {
  let pool = [...cameras];

  // compat selon enregistreur
  if (recorder.kind === "NVR") pool = pool.filter((c) => c.kind === "IP" || c.kind === "UNKNOWN");
  if (recorder.kind === "DVR") pool = pool.filter((c) => c.kind === "COAX" || c.kind === "UNKNOWN");
  // XVR => IP + COAX

  if (wantsOutdoor) pool = pool.filter((c) => c.outdoor);
  if (wantsPoE) pool = pool.filter((c) => c.poe);

  // prix TTC > 0
  pool = pool.filter((c) => typeof c.price_ttc === "number" && (c.price_ttc as number) > 0);

  pool.sort((a, b) => (a.price_ttc as number) - (b.price_ttc as number));
  const picks = pool.slice(0, 3);

  // budget recap
  let budgetRecap: string | null = null;
  if (budget && recorder.price_ttc && picks.length) {
    const unit = picks[0].price_ttc as number;
    const total = Math.round((recorder.price_ttc + camCount * unit) * 100) / 100;
    const status = total <= budget ? "✅ Dans le budget" : "⚠️ Au-dessus du budget (on ajuste la gamme)";
    budgetRecap = `Budget : ${budget.toFixed(0)} € | Estimation : ${total.toFixed(2).replace(".", ",")} € TTC (${camCount} caméras + enregistreur) — ${status}`;
  }

  return { picks, budgetRecap };
}

// --------- Brand cache ----------
let BRAND_CACHE: { at: number; map: Map<string, string> } | null = null;
const BRAND_CACHE_TTL_MS = 10 * 60 * 1000;

async function getBrandMap(supa: ReturnType<typeof supabaseAdmin>) {
  const now = Date.now();
  if (BRAND_CACHE && now - BRAND_CACHE.at < BRAND_CACHE_TTL_MS) return BRAND_CACHE.map;

  const map = new Map<string, string>();
  const { data } = await supa
    .from("webflow_option_map")
    .select("field_slug,option_id,option_name")
    .eq("field_slug", "fabricants");

  if (Array.isArray(data)) {
    for (const r of data as any[]) {
      if (r?.option_id && r?.option_name) map.set(String(r.option_id), String(r.option_name));
    }
  }

  BRAND_CACHE = { at: now, map };
  return map;
}

// --------- Min variant price map ----------
async function getMinVariantPriceMap(supa: ReturnType<typeof supabaseAdmin>, productIds: number[]) {
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
    if (!Number.isFinite(pid) || p === null || !Number.isFinite(p) || p <= 0) continue;
    const prev = map.get(pid);
    if (prev === undefined || p < prev) map.set(pid, p);
  }
  return map;
}

// --------- formatting reply ----------
function formatRecorderBlock(r: RecorderCandidate, title: "✅ Produit recommandé" | "ℹ️ Alternative proposée") {
  const brand = r.brand_name ? ` de chez ${r.brand_name}` : "";
  const sku = r.sku ? ` ${r.sku}` : "";
  return [
    `${title}`,
    `Nom : ${r.name || "N/A"}${sku}${brand}`,
    `Canaux : ${r.channels ?? "N/A"}`,
    `PoE : ${r.poe ? "oui" : "non"}`,
    `Prix : ${formatMoneyEUR_TTC(r.price_ttc)}`,
    `Lien : ${r.url || "N/A"}`,
    r.fiche_technique_url ? `Fiche technique : ${r.fiche_technique_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCameraList(cams: CameraCandidate[]) {
  if (!cams.length) return ""; // IMPORTANT: on n’affiche rien si vide

  const lines: string[] = [];
  lines.push(`📷 Caméras compatibles (prix croissant)`);
  cams.forEach((c, i) => {
    const brand = c.brand_name ? ` de chez ${c.brand_name}` : "";
    const sku = c.sku ? ` ${c.sku}` : "";
    const mp = typeof c.mp === "number" ? ` | ${c.mp} MP` : "";
    lines.push(
      `${i + 1}) ${c.name || "Caméra"}${sku}${brand}${mp}`,
      `   Type : ${c.kind === "IP" ? "IP" : c.kind === "COAX" ? "Coax" : "N/A"}  |  PoE : ${c.poe ? "oui" : "non"}`,
      `   Prix : ${formatMoneyEUR_TTC(c.price_ttc)}`,
      `   Lien : ${c.url || "N/A"}`,
      c.fiche_technique_url ? `   Fiche technique : ${c.fiche_technique_url}` : ""
    );
  });

  return lines.filter(Boolean).join("\n");
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

    // 1) Recorders (ciblé)
    const { data: recRaw, error: recErr } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload,brand")
      .or("name.ilike.%nvr%,name.ilike.%dvr%,name.ilike.%xvr%,name.ilike.%enregistreur%,product_type.ilike.%nvr%,product_type.ilike.%dvr%,product_type.ilike.%xvr%")
      .limit(140);

    if (recErr) {
      return Response.json({ ok: false, error: "Supabase query failed", details: recErr.message }, { status: 500 });
    }

    const recRows: ProductRow[] = Array.isArray(recRaw) ? (recRaw as any) : [];

    // 2) Cameras (ciblé)
    const wantsIPForCameraQuery = need.wantsCoax ? false : true;
    const camOr = wantsIPForCameraQuery
      ? "sku.ilike.ds-2cd%,sku.ilike.ipc-%,name.ilike.%caméra%,name.ilike.%camera%"
      : "sku.ilike.ds-2ce%,name.ilike.%caméra%,name.ilike.%camera%";

    const { data: camRaw, error: camErr } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload,brand")
      .or(camOr)
      .limit(260);

    if (camErr) {
      return Response.json({ ok: false, error: "Supabase query failed", details: camErr.message }, { status: 500 });
    }

    const camRows: ProductRow[] = Array.isArray(camRaw) ? (camRaw as any) : [];

    // 3) min variant price for all loaded ids (rec + cam)
    const allIds = [
      ...recRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n)),
      ...camRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n)),
    ];
    const minVarMap = await getMinVariantPriceMap(supa, Array.from(new Set(allIds)));

    // 4) Exclude AJAX
    const isAjax = (brandName: string | null, name: string | null, sku: string | null) => {
      const b = (brandName || "").toUpperCase();
      const n = (name || "").toLowerCase();
      const s = (sku || "").toLowerCase();
      if (b === "AJAX") return true;
      if (n.includes("ajax")) return true;
      if (s.includes("ajax")) return true;
      return false;
    };

    // 5) Build recorder candidates
    const recordersAll: RecorderCandidate[] = recRows
      .map((r) => {
        const brandOptionId = r.brand ? String(r.brand) : null;
        const brandName = brandOptionId ? brandMap.get(brandOptionId) ?? null : null;

        const name = r.name ?? null;
        const pt = r.product_type ?? "";
        const hay = `${name || ""} ${pt} ${r.sku || ""}`.toLowerCase();

        const kind = detectRecorderKind(hay);
        const channels = extractChannels(name || "") ?? extractChannels(hay);

        const poe = hay.includes("poe");
        const ip = kind === "NVR" || hay.includes("ip");

        const pid = Number(r.id);
        const minVar = minVarMap.get(pid) ?? null;
        const price_ht_final = typeof r.price === "number" && r.price > 0 ? r.price : minVar;
        const price_ttc = priceHtToTtc(price_ht_final);

        return {
          id: pid,
          name,
          url: r.url ?? null,
          price_ttc,
          currency: (r.currency || "EUR") as string | null,
          product_type: r.product_type ?? null,
          sku: r.sku ?? null,
          fiche_technique_url: r.fiche_technique_url ?? null,
          brand_option_id: brandOptionId,
          brand_name: brandName,
          kind,
          channels,
          poe,
          ip,
          price_ht_final,
          min_variant_price: minVar,
        };
      })
      .filter((r) => !isAjax(r.brand_name, r.name, r.sku));

    // 6) Build camera candidates
    const camerasAll: CameraCandidate[] = camRows
      .map((r) => {
        const brandOptionId = r.brand ? String(r.brand) : null;
        const brandName = brandOptionId ? brandMap.get(brandOptionId) ?? null : null;

        const name = r.name ?? null;
        const pt = r.product_type ?? "";
        const hay = `${name || ""} ${pt} ${r.sku || ""}`.toLowerCase();

        const kind = detectCameraKindFromSku(r.sku ?? null);
        const poe = detectCameraPoE(r.payload, hay);
        const outdoor = detectOutdoor(r.payload, hay);
        const mp = extractMP(r.payload, hay);

        const pid = Number(r.id);
        const minVar = minVarMap.get(pid) ?? null;
        const price_ht_final = typeof r.price === "number" && r.price > 0 ? r.price : minVar;
        const price_ttc = priceHtToTtc(price_ht_final);

        return {
          id: pid,
          name,
          url: r.url ?? null,
          price_ttc,
          currency: (r.currency || "EUR") as string | null,
          product_type: r.product_type ?? null,
          sku: r.sku ?? null,
          fiche_technique_url: r.fiche_technique_url ?? null,
          brand_option_id: brandOptionId,
          brand_name: brandName,
          kind,
          poe,
          outdoor,
          mp,
          price_ht_final,
          min_variant_price: minVar,
        };
      })
      .filter((c) => !isAjax(c.brand_name, c.name, c.sku));

    // 7) Pick logic
    const zones = need.zones ?? 5;
    const budget = need.budget ?? null;

    // nombre de caméras à estimer
    const camCount = need.requestedChannels
      ? need.requestedChannels
      : clamp(zones, zones, zones * 2);

    let pickedRecorder: RecorderCandidate | null = null;
    let camerasPicked: CameraCandidate[] = [];
    let budgetRecap: string | null = null;
    let title: "✅ Produit recommandé" | "ℹ️ Alternative proposée" = "✅ Produit recommandé";

    if (need.wantsPack || need.zones !== null || (need.budget !== null && need.wantsCamera)) {
      const wantsIP = need.wantsCoax ? false : true;
      pickedRecorder = pickPackRecorder(recordersAll, zones, need.wantsPoE, wantsIP);
      if (pickedRecorder) {
        const camPick = pickCamerasForRecorder(
          camerasAll,
          pickedRecorder,
          camCount,
          budget,
          need.wantsOutdoor,
          need.wantsPoE
        );
        camerasPicked = camPick.picks;
        budgetRecap = camPick.budgetRecap;
      }
    } else {
      let pool = [...recordersAll];
      if (need.wantsIP) pool = pool.filter((r) => r.kind === "NVR" || r.ip);
      if (need.wantsCoax) pool = pool.filter((r) => r.kind === "DVR" || r.kind === "XVR");
      if (need.wantsPoE) pool = pool.filter((r) => r.poe);

      const picked = pickBestRecorder(pool, need.requestedChannels);
      pickedRecorder = picked.exact ?? picked.fallback ?? null;

      if (!picked.exact && picked.fallback && typeof need.requestedChannels === "number") {
        title = "ℹ️ Alternative proposée";
      }

      // si l’utilisateur parle caméras, on peut proposer une shortlist
      if (pickedRecorder && (need.wantsCamera || need.requestedChannels)) {
        const camPick = pickCamerasForRecorder(
          camerasAll,
          pickedRecorder,
          camCount,
          budget,
          need.wantsOutdoor,
          need.wantsPoE
        );
        camerasPicked = camPick.picks;
        budgetRecap = camPick.budgetRecap;
      }
    }

    if (!pickedRecorder) {
      return Response.json({
        ok: true,
        conversationId,
        reply:
          "Je n’ai pas trouvé d’enregistreur correspondant dans le catalogue.\n\nPour avancer :\n- Combien de caméras au total ? (4 / 8 / 16…)\n- IP (RJ45) ou coaxial (câble TV) ?\n- Budget approximatif ?",
        rag: { used: 0, sources: [] },
        ...(debug ? { debug: { need } } : {}),
      });
    }

    // 8) Reply formatting
    const recorderBlock = formatRecorderBlock(pickedRecorder, title);

    const questions = [
      "Pour affiner :",
      "- Intérieur / extérieur (ou les deux) ?",
      "- Plutôt 1080p, 4MP ou 8MP (4K) ?",
      "- Combien de jours d’archives souhaitez-vous (HDD déjà prévu ou non) ?",
    ].join("\n");

    let camerasBlock = "";
    if (need.wantsCamera || need.wantsPack || need.requestedChannels) {
      const camList = formatCameraList(camerasPicked);
      if (camList) {
        camerasBlock = "\n\n" + camList;
      } else {
        // pas de bloc vide => on bascule sur question directe
        camerasBlock =
          "\n\n📷 Caméras : je peux vous proposer des modèles compatibles, mais il me manque un critère pour trier correctement.\n" +
          "- Vous les voulez plutôt intérieur, extérieur, ou mixte ?\n" +
          "- Résolution visée : 1080p, 4MP, ou 8MP ?";
      }
    }

    const replyParts = [
      recorderBlock,
      budgetRecap ? `\n\n${budgetRecap}` : "",
      camerasBlock,
      `\n\n${questions}`,
    ].filter(Boolean);

    const reply = replyParts.join("");

    const sources = [
      { id: pickedRecorder.id, url: pickedRecorder.url },
      ...camerasPicked.slice(0, 6).map((c) => ({ id: c.id, url: c.url })),
    ].filter((s) => s.url);

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: sources.length ? 1 : 0, sources },
      ...(debug
        ? {
            debug: {
              need,
              camCount,
              budget,
              counts: { recordersAll: recordersAll.length, camerasAll: camerasAll.length, camerasPicked: camerasPicked.length },
              pickedRecorder: { id: pickedRecorder.id, kind: pickedRecorder.kind, channels: pickedRecorder.channels },
              sampleCameraPrices: camerasPicked.map((c) => ({ id: c.id, ht: c.price_ht_final, ttc: c.price_ttc, poe: c.poe })),
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
