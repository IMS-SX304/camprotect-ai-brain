// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string; // optionnel, sinon cookie
  debug?: boolean;
};

type Candidate = {
  id: number;
  name: string | null;
  url: string | null;
  price: number | null; // HT en base (chez toi)
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url?: string | null;
  payload?: any;

  // computed
  channels: number | null;
  poe: boolean;
  ip: boolean;
  kind: "recorder" | "camera" | "other";
  brandLabel: string | null;

  // debug only
  min_variant_price?: number | null;
};

type Need = {
  wantsRecorder: boolean;
  wantsCameras: boolean;
  wantsIP: boolean;
  wantsCoax: boolean;
  wantsPoE: boolean;

  requestedChannels: number | null; // pour enregistreur
  requestedCameras: number | null;  // nombre de caméras explicite
  zones: number | null;             // "5 zones"
  cameraRange: { min: number; target: number; max: number } | null;

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
  // "1500€" / "1 500 €" / "budget 1500"
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

function estimateCameraRangeFromZones(zones: number): { min: number; target: number; max: number } {
  const min = zones;
  const max = zones * 2;
  const target = Math.round((min + max) / 2); // X*1.5
  return { min, target, max };
}

function extractRequestedCameras(text: string): number | null {
  const t = text.toLowerCase();
  // "4 caméras"
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

function detectNeed(input: string): Need {
  const t = input.toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsCameras =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP =
    t.includes("ip") || t.includes("nvr") || t.includes("réseau") || t.includes("rj45");

  const wantsCoax =
    t.includes("coax") || t.includes("coaxial") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd");

  const wantsPoE = t.includes("poe");

  const requestedChannels = extractChannels(input);
  const requestedCameras = extractRequestedCameras(input);

  const zones = extractZones(input);
  const cameraRange = zones ? estimateCameraRangeFromZones(zones) : null;

  const budget = extractBudgetEUR(input);

  return {
    wantsRecorder,
    wantsCameras,
    wantsIP,
    wantsCoax,
    wantsPoE,
    requestedChannels: requestedChannels && requestedChannels > 0 ? requestedChannels : null,
    requestedCameras: requestedCameras && requestedCameras > 0 ? requestedCameras : null,
    zones,
    cameraRange,
    budget,
  };
}

function moneyTTC(priceHT: number, vat = 0.2) {
  const ttc = priceHT * (1 + vat);
  return Math.round(ttc * 100) / 100;
}

function formatEUR(n: number): string {
  // 135.24 => "135,24"
  return n.toFixed(2).replace(".", ",");
}

function isAjaxProduct(r: any): boolean {
  const name = (r?.name || r?.payload?.name || "").toString().toLowerCase();
  const sku = (r?.sku || "").toString().toLowerCase();
  const brandId = (r?.payload?.fabricants || r?.payload?.brand || "").toString().toLowerCase();
  const brandLabel = (r?.brand_label || "").toString().toLowerCase();
  // On filtre large pour éviter toute pollution
  return (
    name.includes("ajax") ||
    sku.includes("ajax") ||
    brandLabel.includes("ajax") ||
    brandId === "9b270d1e370c9f1ad85ecf2d78824810"
  );
}

function inferKind(row: any): "recorder" | "camera" | "other" {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const pt = (row?.product_type || row?.payload?.["ec-product-type"] || "").toString().toLowerCase();

  const recorder = /enregistreur|nvr|dvr|xvr/.test(name) || /nvr|dvr|xvr/.test(pt);
  if (recorder) return "recorder";

  // caméra IP/analog : on se base sur "caméra" dans le nom ou type produit
  const camera = /caméra|camera|bullet|dome|turret/.test(name) || pt.includes("cam") || pt.includes("camera");
  if (camera) return "camera";

  return "other";
}

function inferIsIP(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const tech = (row?.payload?.technologie || row?.payload?.technology || "").toString().toLowerCase();
  const compat = (row?.payload?.["compatibilité caméra"] || row?.payload?.compatibilite || "").toString().toLowerCase();
  // indices "IP"
  return name.includes("ip") || name.includes("nvr") || tech.includes("réseau") || tech.includes("reseau") || compat.includes("onvif");
}

function inferIsCoax(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const compat = (row?.payload?.["compatibilité caméra"] || row?.payload?.compatibilite || "").toString().toLowerCase();
  return /tvi|cvi|ahd|cvbs|coax|coaxial|analog/.test(name) || /tvi|cvi|ahd|cvbs|coax|analog/.test(compat);
}

function inferIsPoE(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const alim = (row?.payload?.alimentation || "").toString().toLowerCase();
  const ports = (row?.payload?.["port et connectivité"] || "").toString().toLowerCase();
  return name.includes("poe") || alim.includes("poe") || ports.includes("poe");
}

function brandLabelFromRow(row: any): string | null {
  // si tu as déjà un champ "brand_label" rempli via webflow_options, on l’utilise.
  const b = (row?.brand_label || row?.payload?.brand_label || "").toString().trim();
  return b || null;
}

function pickRecorder(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  if (!requestedChannels) {
    // plus petit en premier
    const sorted = [...candidates].sort((a, b) => (a.channels ?? 9999) - (b.channels ?? 9999));
    return { exact: sorted[0] ?? null, fallback: null };
  }

  const exact = candidates.find((c) => c.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = candidates
    .filter((c) => typeof c.channels === "number" && (c.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

function pickCamerasIPCompatible(allCameras: Candidate[], count: number, budget: number | null) {
  // on prend des caméras IP (pas coax), prix croissant, et on sort 3 propositions "prix croissant"
  const cams = allCameras
    .filter((c) => c.kind === "camera" && c.ip && !inferIsCoax(c))
    .filter((c) => typeof c.price === "number" && (c.price as number) > 0);

  const sorted = cams.sort((a, b) => (a.price ?? 999999) - (b.price ?? 999999));

  // Si budget donné : on s’assure qu’une caméra n’explose pas le budget (soft filter)
  const filtered = budget
    ? sorted.filter((c) => {
        const ttc = typeof c.price === "number" ? moneyTTC(c.price) : 0;
        // heuristique : caméra <= 60% du budget total/nb cam
        const maxPerCam = (budget / Math.max(1, count)) * 0.6;
        return ttc <= Math.max(120, maxPerCam);
      })
    : sorted;

  const base = filtered.length ? filtered : sorted;
  return base.slice(0, 3);
}

/** Cookie helpers */
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;
    const input = (body.input || "").trim();
    if (!input) return Response.json({ ok: false, error: "Missing input" }, { status: 400 });

    const debug = !!body.debug;

    // conversationId: body > cookie > new
    const cookieId = getCookie(req, "cp_conversation_id");
    const conversationId = body.conversationId || cookieId || crypto.randomUUID();

    const need = detectNeed(input);
    const supa = supabaseAdmin();

    // --- session load / upsert
    const { data: sess } = await supa.from("chat_sessions").select("id,state").eq("id", conversationId).maybeSingle();

    const prevState = (sess?.state || {}) as any;

    // merge state: on conserve ce qu’on sait déjà si non redonné
    const state = {
      ...prevState,
      budget: need.budget ?? prevState?.budget ?? null,
      requestedCameras: need.requestedCameras ?? prevState?.requestedCameras ?? null,
      requestedChannels: need.requestedChannels ?? prevState?.requestedChannels ?? null,
      zones: need.zones ?? prevState?.zones ?? null,
      cameraRange: need.cameraRange ?? prevState?.cameraRange ?? null,
      // on garde aussi le dernier recorder choisi si déjà établi (important cohérence)
      chosenRecorderId: prevState?.chosenRecorderId ?? null,
      chosenRecorderSku: prevState?.chosenRecorderSku ?? null,
    };

    // save session
    await supa
      .from("chat_sessions")
      .upsert({
        id: conversationId,
        last_user_message: input,
        state,
      });

    // --- Load products (on limite + on select juste ce qu’on utilise)
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload,brand_label")
      .limit(800);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rowsAll = Array.isArray(raw) ? raw : [];

    // Exclure AJAX du catalogue suggestions (comme demandé)
    const rows = rowsAll.filter((r: any) => !isAjaxProduct(r));

    // Min price variants (fallback) si prix produit manquant
    const productIds = rows.map((r: any) => Number(r.id)).filter((n) => Number.isFinite(n));
    const minPriceByProductId = new Map<number, number>();

    if (productIds.length) {
      const { data: vars } = await supa.from("product_variants").select("product_id,price").in("product_id", productIds);
      if (Array.isArray(vars)) {
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

        const minVar = minPriceByProductId.get(pid) ?? null;
        const finalPrice = typeof r.price === "number" ? r.price : (typeof minVar === "number" ? minVar : null);

        const kind = inferKind(r);
        const channels = extractChannels(name || "") ?? extractChannels((r.payload?.["nombre de canaux"] || "").toString());
        const poe = inferIsPoE(r);
        const ip = inferIsIP(r);

        return {
          id: pid,
          name,
          url: (r.url || null) as string | null,
          price: finalPrice,
          currency: (r.currency || "EUR") as string | null,
          product_type: (r.product_type || null) as string | null,
          sku: (r.sku || null) as string | null,
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,
          payload: r.payload || null,
          channels: channels && Number.isFinite(channels) ? Number(channels) : null,
          poe,
          ip,
          kind,
          brandLabel: brandLabelFromRow(r),
          min_variant_price: minVar,
        };
      })
      .filter((c) => c.url && c.name); // base clean

    // --- Build search pools
    const recordersAll = candidatesAll.filter((c) => c.kind === "recorder");
    const camerasAll = candidatesAll.filter((c) => c.kind === "camera");

    // --- Recorder pick logic (et cohérence conversation)
    let recorderExact: Candidate | null = null;
    let recorderFallback: Candidate | null = null;

    // si on avait déjà un recorder choisi précédemment, on le garde sauf si le client demande explicitement autre chose
    const existingRecorderId = state.chosenRecorderId ? Number(state.chosenRecorderId) : null;
    const existingRecorder = existingRecorderId ? recordersAll.find((r) => r.id === existingRecorderId) ?? null : null;

    const wantRecorderNow = need.wantsRecorder || existingRecorder !== null;

    if (wantRecorderNow) {
      const requestedChannels = state.requestedChannels ?? need.requestedChannels ?? null;

      // filtrage IP/PoE si demandé
      let pool = recordersAll;
      if (need.wantsIP) pool = pool.filter((r) => r.ip);
      if (need.wantsPoE) pool = pool.filter((r) => r.poe);

      const picked = pickRecorder(pool, requestedChannels);

      recorderExact = picked.exact ?? null;
      recorderFallback = picked.fallback ?? null;

      const chosen = recorderExact || recorderFallback || existingRecorder;

      if (chosen) {
        state.chosenRecorderId = chosen.id;
        state.chosenRecorderSku = chosen.sku;
        await supa.from("chat_sessions").update({ state }).eq("id", conversationId);
      }
    }

    const chosenRecorder = (state.chosenRecorderId
      ? recordersAll.find((r) => r.id === Number(state.chosenRecorderId)) ?? null
      : null) as Candidate | null;

    // --- Camera range logic from zones
    const zones = state.zones ?? null;
    const cameraRange = state.cameraRange ?? null;

    // nb caméras “cible”
    const requestedCams = state.requestedCameras ?? null;
    const camsTarget =
      requestedCams ??
      (cameraRange?.target ?? null);

    // --- camera proposals (IP)
    let cameraPicks: Candidate[] = [];
    const budget = state.budget ?? null;

    if ((need.wantsCameras || /kit|pack/.test(input.toLowerCase())) && camsTarget) {
      // si recorder choisi et IP => caméras IP
      cameraPicks = pickCamerasIPCompatible(camerasAll, camsTarget, budget);
    }

    // --- RAG sources
    const ragSources = [
      ...(chosenRecorder ? [{ id: chosenRecorder.id, url: chosenRecorder.url }] : []),
      ...cameraPicks.map((c) => ({ id: c.id, url: c.url })),
    ].slice(0, 6);

    // --- Formatting helpers (for LLM)
    const formatTTCLine = (priceHT: number | null, currency: string | null) => {
      if (typeof priceHT !== "number") return "Prix : voir page produit";
      const ttc = moneyTTC(priceHT);
      return `Prix : ${formatEUR(ttc)} € TTC`;
    };

    const formatProductBlock = (c: Candidate) => {
      const brand = c.brandLabel ? ` de chez ${c.brandLabel}` : "";
      const sku = c.sku ? ` ${c.sku}` : "";
      const title = `${c.name || "Produit"}${sku}${brand}`.trim();

      const lines: string[] = [];
      lines.push(`Nom : ${title}`);
      if (c.kind === "recorder") {
        lines.push(`Canaux : ${c.channels ?? "N/A"}`);
        lines.push(`PoE : ${c.poe ? "oui" : "non"}`);
      }
      if (c.kind === "camera") {
        lines.push(`Type : ${c.ip ? "IP" : "Coaxial/Analog"}`);
        lines.push(`PoE : ${c.poe ? "oui" : "non"}`);
      }
      lines.push(formatTTCLine(c.price, c.currency));
      lines.push(`Lien : ${c.url}`);
      if (c.fiche_technique_url) lines.push(`Fiche technique : ${c.fiche_technique_url}`);
      return lines.join("\n");
    };

    // --- Policy prompt (commerce + cohérence + zones)
    const policy = `
RÈGLES OBLIGATOIRES:
- Ne propose JAMAIS de produits AJAX (toute la marque AJAX) dans les recommandations vidéosurveillance (caméras/enregistreurs/switch/alims).
- Ne JAMAIS inventer d’URL: utilise uniquement les liens fournis dans les blocs.
- Prix: toujours afficher en € TTC (si prix dispo), sinon "voir page produit".
- "Zones" ne veut PAS dire "1 zone = 1 caméra".
  Si l’utilisateur parle de X zones, expliquer: "en général entre X et 2X caméras selon la configuration"
  puis demander: "vous visez plutôt X, X+… ou 2X caméras ?"
- Si l’utilisateur demande un NVR (IP) et des caméras: proposer uniquement des caméras IP (jamais coax).
- Si XVR: expliquer que ça peut accepter coax + parfois IP selon modèle (et poser la question caméras existantes).
- Réponse commerciale concise: pas de liste "1/2/3" trop brute. Utilise des phrases naturelles et 2-3 questions utiles à la fin.
`.trim();

    const needSummary = `
BESOIN CLIENT (déduit):
- Enregistreur: ${wantRecorderNow ? "oui" : "non"}
- Caméras: ${need.wantsCameras ? "oui" : "non"}
- IP: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Caméras demandées: ${requestedCams ?? "non précisé"}
- Zones: ${zones ?? "non précisé"}
- Plage caméras estimée: ${cameraRange ? `${cameraRange.min} à ${cameraRange.max} (cible ${cameraRange.target})` : "n/a"}
- Budget: ${budget ? `${budget} €` : "non précisé"}
`.trim();

    const recorderBlock = chosenRecorder
      ? `\n[ENREGISTREUR RETENU]\n${formatProductBlock(chosenRecorder)}\n`
      : "";

    const camerasBlock = cameraPicks.length
      ? `\n[CAMÉRAS À PROPOSER (prix croissant)]\n${cameraPicks.map((c, i) => `Caméra ${i + 1}\n${formatProductBlock(c)}`).join("\n\n")}\n`
      : "";

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

    // save assistant message
    await supa
      .from("chat_sessions")
      .update({ last_assistant_message: reply, state })
      .eq("id", conversationId);

    const headers = new Headers({ "content-type": "application/json" });
    if (!cookieId) setCookie(headers, "cp_conversation_id", conversationId);

    return new Response(
      JSON.stringify({
        ok: true,
        conversationId,
        reply,
        rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
        ...(debug
          ? {
              debug: {
                need,
                state,
                chosenRecorder: chosenRecorder
                  ? { id: chosenRecorder.id, sku: chosenRecorder.sku, url: chosenRecorder.url, channels: chosenRecorder.channels }
                  : null,
                cameraPicks: cameraPicks.map((c) => ({ id: c.id, sku: c.sku, url: c.url, price: c.price })),
              },
            }
          : {}),
      }),
      { status: 200, headers }
    );
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
