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

  price: number | null;              // HT
  min_variant_price?: number | null; // HT (fallback)

  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url?: string | null;
  payload?: any;

  channels: number | null;
  poe: boolean;
  ip: boolean;

  kind: "recorder" | "camera" | "other";
  brandLabel: string | null;
};

type Need = {
  wantsPack: boolean;
  wantsIP: boolean;
  wantsPoE: boolean;
  zones: number | null;
  cameraRange: { min: number; target: number; max: number } | null;
  requestedCameras: number | null;
  budget: number | null;
};

function parseNumberFR(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/\s/g, "").replace(",", ".").replace("€", "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractBudgetEUR(text: string): number | null {
  const t = text.toLowerCase();
  const m = t.match(/(?:budget\s*de?\s*)?(\d[\d\s]{2,7})(?:\s*€|euros?)\b/i);
  if (!m) return null;
  const n = parseNumberFR(m[1]);
  return n && n > 0 ? n : null;
}

function extractZones(text: string): number | null {
  const m = text.toLowerCase().match(/(\d{1,2})\s*(zones?|emplacements?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function estimateCameraRangeFromZones(zones: number) {
  const min = zones;
  const max = zones * 2;
  const target = Math.round((min + max) / 2);
  return { min, target, max };
}

function extractRequestedCameras(text: string): number | null {
  const t = text.toLowerCase();
  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|cameras?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractChannels(text: string): number | null {
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function moneyTTC(priceHT: number, vat = 0.2) {
  const ttc = priceHT * (1 + vat);
  return Math.round(ttc * 100) / 100;
}

function formatEUR(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

function detectNeed(input: string): Need {
  const t = input.toLowerCase();

  const wantsPack =
    t.includes("kit") ||
    t.includes("pack") ||
    t.includes("solution complète") ||
    t.includes("solution complete") ||
    t.includes("tout compris") ||
    (t.includes("caméras") && t.includes("enregistreur"));

  const wantsIP = t.includes("ip") || t.includes("nvr") || t.includes("rj45") || t.includes("réseau") || t.includes("reseau");
  const wantsPoE = t.includes("poe");

  const zones = extractZones(input);
  const cameraRange = zones ? estimateCameraRangeFromZones(zones) : null;

  const requestedCameras = extractRequestedCameras(input);
  const budget = extractBudgetEUR(input);

  return { wantsPack, wantsIP, wantsPoE, zones, cameraRange, requestedCameras, budget };
}

// ===== Exclure AJAX (tout) =====
function isAjaxProduct(r: any): boolean {
  const name = (r?.name || r?.payload?.name || "").toString().toLowerCase();
  const sku = (r?.sku || "").toString().toLowerCase();
  const fabricants = (r?.payload?.fabricants || r?.payload?.fabricant || "").toString().toLowerCase();
  const AJAX_ID = "9b270d1e370c9f1ad85ecf2d78824810";
  return name.includes("ajax") || sku.includes("ajax") || fabricants === AJAX_ID || fabricants === "ajax";
}

// ===== Heuristiques IP/COAX robustes =====
function refString(row: any): string {
  const n = (row?.name || row?.payload?.name || "").toString();
  const sku = (row?.sku || "").toString();
  const pref = (row?.payload?.["product-reference"] || row?.payload?.["product reference"] || row?.payload?.["product_reference"] || "").toString();
  const codeFab = (row?.payload?.["code-fabricant"] || row?.payload?.["code fabricant"] || "").toString();
  // IMPORTANT : on ajoute des champs souvent utiles si présents
  const techno = (row?.payload?.technologie || row?.payload?.["technologie"] || "").toString();
  const alim = (row?.payload?.alimentation || row?.payload?.["alimentation"] || "").toString();
  return `${n} ${sku} ${pref} ${codeFab} ${techno} ${alim}`.toLowerCase();
}

function looksLikeIPCamera(row: any): boolean {
  const s = refString(row);
  return (
    s.includes("ds-2cd") ||
    s.includes("ipc-") ||
    s.includes("dh-ipc") ||
    s.includes("dhi-ipc") ||
    s.includes("network camera") ||
    s.includes("camera ip") ||
    s.includes("caméra ip") ||
    s.includes("cam ip") ||
    s.includes("onvif")
  );
}

function looksLikeCoaxCamera(row: any): boolean {
  const s = refString(row);
  return (
    s.includes("ds-2ce") ||
    s.includes("hac-") ||
    s.includes("dh-hac") ||
    s.includes("dhi-hac") ||
    s.includes("tvi") ||
    s.includes("cvi") ||
    s.includes("ahd")
  );
}

function inferKind(row: any): "recorder" | "camera" | "other" {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const pt = (row?.product_type || row?.payload?.["ec-product-type"] || "").toString().toLowerCase();

  const recorder = /enregistreur|nvr|dvr|xvr/.test(name) || /nvr|dvr|xvr/.test(pt);
  if (recorder) return "recorder";

  const camera = /caméra|camera|bullet|dome|turret/.test(name) || pt.includes("cam");
  if (camera) return "camera";

  return "other";
}

function inferIsPoE(row: any): boolean {
  const s = refString(row);
  const alim = (row?.payload?.alimentation || row?.payload?.["alimentation"] || "").toString().toLowerCase();
  const ports = (row?.payload?.["port et connectivité"] || row?.payload?.["port et connectivite"] || "").toString().toLowerCase();
  return s.includes("poe") || alim.includes("poe") || ports.includes("poe");
}

function inferIsIP(row: any, kind: "recorder" | "camera" | "other"): boolean {
  const s = refString(row);

  if (kind === "recorder") {
    if (s.includes("nvr")) return true;
    if (s.includes("dvr")) return false;
    if (s.includes("xvr")) return true; // hybride
    return s.includes("ip") || s.includes("réseau") || s.includes("reseau");
  }

  if (kind === "camera") {
    if (looksLikeIPCamera(row)) return true;
    if (looksLikeCoaxCamera(row)) return false;
    return s.includes("ip") || s.includes("réseau") || s.includes("reseau") || s.includes("onvif");
  }

  return s.includes("ip");
}

function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(headers: Headers, name: string, value: string) {
  headers.append(
    "set-cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
}

function finalPriceHT(c: Candidate): number | null {
  if (typeof c.price === "number") return c.price;
  if (typeof c.min_variant_price === "number") return c.min_variant_price;
  return null;
}

function formatTTCLine(c: Candidate) {
  const ht = finalPriceHT(c);
  if (typeof ht !== "number") return "Prix : voir page produit";
  const ttc = moneyTTC(ht);
  return `Prix : ${formatEUR(ttc)} € TTC`;
}

function normalizeTitleLine(c: Candidate) {
  const brand = c.brandLabel ? ` de chez ${c.brandLabel}` : "";
  const sku = c.sku || "";
  const name = c.name || "Produit";
  const hasSku = sku && name.toLowerCase().includes(sku.toLowerCase());
  const skuPart = sku && !hasSku ? ` ${sku}` : "";
  return `${name}${skuPart}${brand}`.trim();
}

function formatProductBlock(c: Candidate) {
  const lines: string[] = [];
  lines.push(`- ${normalizeTitleLine(c)}`);

  if (c.kind === "recorder") {
    lines.push(`  Canaux : ${c.channels ?? "N/A"}  |  PoE : ${c.poe ? "oui" : "non"}  |  IP : ${c.ip ? "oui" : "non"}`);
  } else if (c.kind === "camera") {
    lines.push(`  Type : ${c.ip ? "IP" : "Coaxial"}  |  PoE : ${c.poe ? "oui" : "non"}`);
  }

  lines.push(`  ${formatTTCLine(c)}`);
  lines.push(`  Lien : ${c.url}`);

  if (c.fiche_technique_url) {
    lines.push(`  Fiche technique : ${c.fiche_technique_url}`);
  }

  return lines.join("\n");
}

function pickBestRecorderForPack(recorders: Candidate[], channelsNeed: number) {
  // 1) préférence : NVR PoE
  let pool = recorders
    .filter((r) => r.kind === "recorder")
    .filter((r) => typeof r.channels === "number" && (r.channels as number) >= channelsNeed)
    .filter((r) => r.ip);

  const poolPoE = pool.filter((r) => r.poe);
  const usedFallback = poolPoE.length === 0;

  const finalPool = poolPoE.length ? poolPoE : pool;

  finalPool.sort((a, b) => {
    const ca = a.channels ?? 9999;
    const cb = b.channels ?? 9999;
    if (ca !== cb) return ca - cb;

    const pa = finalPriceHT(a) ?? 999999;
    const pb = finalPriceHT(b) ?? 999999;
    return pa - pb;
  });

  return { recorder: finalPool[0] ?? null, usedFallbackPoE: usedFallback };
}

function pickCamerasForPack(cameras: Candidate[], preferPoE: boolean) {
  const ipPool = cameras.filter((c) => c.kind === "camera" && c.ip);

  // ✅ On tente IP+PoE, sinon fallback IP
  let pool = preferPoE ? ipPool.filter((c) => c.poe) : ipPool;
  const usedFallbackPoE = preferPoE && pool.length === 0;

  if (usedFallbackPoE) pool = ipPool;

  // tri prix croissant (prix manquants à la fin)
  pool.sort((a, b) => {
    const pa = finalPriceHT(a);
    const pb = finalPriceHT(b);
    if (typeof pa !== "number" && typeof pb !== "number") return 0;
    if (typeof pa !== "number") return 1;
    if (typeof pb !== "number") return -1;
    return pa - pb;
  });

  return { cameras: pool.slice(0, 3), usedFallbackPoE };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;
    const input = (body.input || "").trim();
    if (!input) return Response.json({ ok: false, error: "Missing input" }, { status: 400 });

    const debug = !!body.debug;
    const cookieId = getCookie(req, "cp_conversation_id");
    const conversationId = body.conversationId || cookieId || crypto.randomUUID();

    const need = detectNeed(input);
    const supa = supabaseAdmin();

    // ===== Charger mapping fabricants depuis webflow_options =====
    const brandMap = new Map<string, string>();
    {
      const { data: opts, error: oErr } = await supa
        .from("webflow_options")
        .select("field_slug,option_id,option_name")
        .eq("field_slug", "fabricants")
        .limit(200);

      if (!oErr && Array.isArray(opts)) {
        for (const o of opts as any[]) {
          const id = (o.option_id || "").toString();
          const name = (o.option_name || "").toString();
          if (id && name) brandMap.set(id, name);
        }
      }
    }

    // Load products
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(2000);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rowsAll = Array.isArray(raw) ? raw : [];
    const rows = rowsAll.filter((r: any) => !isAjaxProduct(r));

    // --- MIN PRICE VARIANTS (fallback) ---
    const productIds = rows.map((r: any) => Number(r.id)).filter((n) => Number.isFinite(n));
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
        const pid = Number(r.id);
        const name = (r.name || r.payload?.name || "").toString().trim() || null;
        const kind = inferKind(r);

        const channels =
          extractChannels(name || "") ??
          extractChannels((r.payload?.["nombre de canaux"] || "").toString());

        const poe = inferIsPoE(r);
        const ip = inferIsIP(r, kind);

        const minVar = minPriceByProductId.get(pid) ?? null;

        const fabricantsId = (r.payload?.fabricants || r.payload?.fabricant || "").toString().trim();
        const brandLabel = fabricantsId ? (brandMap.get(fabricantsId) || null) : null;

        return {
          id: pid,
          name,
          url: (r.url || null) as string | null,
          price: typeof r.price === "number" ? r.price : null,
          min_variant_price: typeof minVar === "number" ? minVar : null,
          currency: (r.currency || "EUR") as string | null,
          product_type: (r.product_type || null) as string | null,
          sku: (r.sku || null) as string | null,
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,
          payload: r.payload || null,
          channels: channels && Number.isFinite(channels) ? Number(channels) : null,
          poe,
          ip,
          kind,
          brandLabel,
        };
      })
      .filter((c) => c.url && c.name);

    const recordersAll = candidatesAll.filter((c) => c.kind === "recorder");
    const camerasAll = candidatesAll.filter((c) => c.kind === "camera");

    // ===== PACK =====
    const zones = need.zones;
    const cameraRange = need.cameraRange;

    const effectiveCamsTarget =
      need.requestedCameras ??
      (cameraRange?.target ?? null) ??
      4;

    // ✅ Changement clé :
    // - on préfère PoE si pack
    // - MAIS on ne bloque plus si aucun PoE détecté
    const preferPoE = need.wantsPoE || need.wantsPack;

    if (need.wantsPack) {
      const pickedRecorder = pickBestRecorderForPack(recordersAll, effectiveCamsTarget);
      const pickedCams = pickCamerasForPack(camerasAll, preferPoE);

      const intro = zones
        ? `Pour couvrir ${zones} zones, on part souvent sur ${cameraRange?.min} à ${cameraRange?.max} caméras (selon angles et distances). Je vous propose une base simple et évolutive :`
        : `Je vous propose une base simple et évolutive :`;

      const lines: string[] = [];
      lines.push(intro);
      lines.push("");
      lines.push("✅ Enregistreur proposé");
      lines.push(pickedRecorder.recorder ? formatProductBlock(pickedRecorder.recorder) : "- Aucun enregistreur trouvé");
      if (pickedRecorder.usedFallbackPoE) {
        lines.push("  ⚠️ Note : cet enregistreur n’intègre pas le PoE → prévoir un switch PoE / injecteurs PoE si vous partez sur des caméras PoE.");
      }

      lines.push("");
      lines.push("📷 Caméras IP compatibles (prix croissant)");
      if (pickedCams.cameras.length) {
        pickedCams.cameras.forEach((c, i) => lines.push(`${i + 1}) ${formatProductBlock(c)}`));
      } else {
        lines.push("- Aucune caméra IP n’a été détectée comme compatible (à vérifier côté détection IP / données produit).");
      }
      if (pickedCams.usedFallbackPoE) {
        lines.push("  ⚠️ Note : je n’ai pas détecté de caméras IP avec PoE renseigné → je vous affiche des caméras IP compatibles (PoE à confirmer sur la fiche).");
      }

      lines.push("");
      lines.push("Pour affiner rapidement :");
      lines.push(`- Vous visez plutôt ${cameraRange ? `${cameraRange.min} à ${cameraRange.max}` : "combien"} caméras au total ?`);
      lines.push("- Installation : intérieur / extérieur (ou les deux) ?");
      lines.push("- Stockage : combien de jours d’archives souhaitez-vous (HDD déjà prévu ou non) ?");

      const headers = new Headers({ "content-type": "application/json" });
      if (!cookieId) setCookie(headers, "cp_conversation_id", conversationId);

      return new Response(
        JSON.stringify({
          ok: true,
          conversationId,
          reply: lines.join("\n"),
          ...(debug
            ? {
                debug: {
                  need,
                  counts: {
                    candidatesAll: candidatesAll.length,
                    recordersAll: recordersAll.length,
                    camerasAll: camerasAll.length,
                    pickedCameras: pickedCams.cameras.length,
                  },
                  cameraPick: {
                    preferPoE,
                    usedFallbackPoE: pickedCams.usedFallbackPoE,
                  },
                  sampleCameras: camerasAll.slice(0, 5).map((c) => ({
                    id: c.id,
                    name: c.name,
                    ip: c.ip,
                    poe: c.poe,
                    sku: c.sku,
                    price: c.price,
                    min_variant_price: c.min_variant_price,
                    url: c.url,
                  })),
                },
              }
            : {}),
        }),
        { status: 200, headers }
      );
    }

    // fallback LLM hors pack
    const reply = await chatCompletion([
      { role: "system", content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "user", content: input },
    ]);

    const headers = new Headers({ "content-type": "application/json" });
    if (!cookieId) setCookie(headers, "cp_conversation_id", conversationId);

    return new Response(JSON.stringify({ ok: true, conversationId, reply }), { status: 200, headers });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
