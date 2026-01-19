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
  price: number | null; // HT en base (chez toi)
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

  min_variant_price?: number | null;
};

type Need = {
  wantsRecorder: boolean;
  wantsCameras: boolean;
  wantsIP: boolean;
  wantsCoax: boolean;
  wantsPoE: boolean;
  requestedChannels: number | null;
  requestedCameras: number | null;
  zones: number | null;
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

function detectNeed(input: string): Need {
  const t = input.toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsCameras =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras") || t.includes("kit") || t.includes("pack");

  const wantsIP = t.includes("ip") || t.includes("nvr") || t.includes("réseau") || t.includes("rj45");
  const wantsCoax = t.includes("coax") || t.includes("coaxial") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd");
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
  return n.toFixed(2).replace(".", ",");
}

function isAjaxProduct(r: any): boolean {
  const name = (r?.name || r?.payload?.name || "").toString().toLowerCase();
  const sku = (r?.sku || "").toString().toLowerCase();
  const fabricants = (r?.payload?.fabricants || r?.payload?.fabricant || "").toString().toLowerCase();
  const AJAX_ID = "9b270d1e370c9f1ad85ecf2d78824810";
  return name.includes("ajax") || sku.includes("ajax") || fabricants === AJAX_ID || fabricants === "ajax";
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

function inferIsIP(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const tech = (row?.payload?.technologie || row?.payload?.technology || "").toString().toLowerCase();
  const compat = (row?.payload?.["compatibilité caméra"] || row?.payload?.compatibilite || "").toString().toLowerCase();
  return name.includes("ip") || name.includes("nvr") || tech.includes("réseau") || tech.includes("reseau") || compat.includes("onvif");
}

function inferIsPoE(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const alim = (row?.payload?.alimentation || "").toString().toLowerCase();
  const ports = (row?.payload?.["port et connectivité"] || "").toString().toLowerCase();
  return name.includes("poe") || alim.includes("poe") || ports.includes("poe");
}

function brandLabelFromRow(row: any): string | null {
  const p = row?.payload || {};
  const fromLabel = (p.fabricant_label || p.fabricants_label || p.brand_label || "").toString().trim();
  if (fromLabel) return fromLabel;

  const raw = (p.fabricant || p.fabricants || "").toString().trim();
  if (raw && raw.length < 40 && /^[A-Za-z0-9 _-]+$/.test(raw)) return raw;

  return null;
}

function pickRecorder(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  if (!requestedChannels) {
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

function pickCamerasIP(allCameras: Candidate[], count: number, budget: number | null) {
  const cams = allCameras
    .filter((c) => c.kind === "camera" && c.ip)
    .filter((c) => typeof c.price === "number" && (c.price as number) > 0);

  const sorted = cams.sort((a, b) => (a.price ?? 999999) - (b.price ?? 999999));

  const filtered = budget
    ? sorted.filter((c) => {
        const ttc = typeof c.price === "number" ? moneyTTC(c.price) : 0;
        const maxPerCam = (budget / Math.max(1, count)) * 0.6;
        return ttc <= Math.max(120, maxPerCam);
      })
    : sorted;

  const base = filtered.length ? filtered : sorted;
  return base.slice(0, 3);
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

    const { data: sess } = await supa
      .from("chat_sessions")
      .select("id,state")
      .eq("id", conversationId)
      .maybeSingle();

    const prevState = (sess?.state || {}) as any;

    const state = {
      ...prevState,
      budget: need.budget ?? prevState?.budget ?? null,
      requestedCameras: need.requestedCameras ?? prevState?.requestedCameras ?? null,
      requestedChannels: need.requestedChannels ?? prevState?.requestedChannels ?? null,
      zones: need.zones ?? prevState?.zones ?? null,
      cameraRange: need.cameraRange ?? prevState?.cameraRange ?? null,
      chosenRecorderId: prevState?.chosenRecorderId ?? null,
      chosenRecorderSku: prevState?.chosenRecorderSku ?? null,
    };

    await supa.from("chat_sessions").upsert({
      id: conversationId,
      last_user_message: input,
      state,
    });

    // ✅ IMPORTANT: aucun brand_label ici
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(800);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rowsAll = Array.isArray(raw) ? raw : [];
    const rows = rowsAll.filter((r: any) => !isAjaxProduct(r));

    const candidatesAll: Candidate[] = rows.map((r: any) => {
      const pid = Number(r.id);
      const name = (r.name || r.payload?.name || "").toString().trim() || null;

      const kind = inferKind(r);
      const channels =
        extractChannels(name || "") ??
        extractChannels((r.payload?.["nombre de canaux"] || "").toString());

      const poe = inferIsPoE(r);
      const ip = inferIsIP(r);

      return {
        id: pid,
        name,
        url: (r.url || null) as string | null,
        price: typeof r.price === "number" ? r.price : null,
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
      };
    }).filter((c) => c.url && c.name);

    const recordersAll = candidatesAll.filter((c) => c.kind === "recorder");
    const camerasAll = candidatesAll.filter((c) => c.kind === "camera");

    const requestedChannels = state.requestedChannels ?? null;

    let pool = recordersAll;
    if (need.wantsIP) pool = pool.filter((r) => r.ip);
    if (need.wantsPoE) pool = pool.filter((r) => r.poe);

    const picked = pickRecorder(pool, requestedChannels);

    const chosenRecorder = picked.exact || picked.fallback || null;
    if (chosenRecorder) {
      state.chosenRecorderId = chosenRecorder.id;
      state.chosenRecorderSku = chosenRecorder.sku;
      await supa.from("chat_sessions").update({ state }).eq("id", conversationId);
    }

    const zones = state.zones ?? null;
    const cameraRange = state.cameraRange ?? null;

    const camsTarget =
      state.requestedCameras ??
      (cameraRange?.target ?? null);

    const budget = state.budget ?? null;

    const cameraPicks =
      need.wantsCameras && camsTarget
        ? pickCamerasIP(camerasAll, camsTarget, budget)
        : [];

    const ragSources = [
      ...(chosenRecorder ? [{ id: chosenRecorder.id, url: chosenRecorder.url }] : []),
      ...cameraPicks.map((c) => ({ id: c.id, url: c.url })),
    ].slice(0, 6);

    const formatTTCLine = (priceHT: number | null) => {
      if (typeof priceHT !== "number") return "Prix : voir page produit";
      const ttc = moneyTTC(priceHT);
      return `Prix : ${formatEUR(ttc)} € TTC`;
    };

    const titleLine = (c: Candidate) => {
      const brand = c.brandLabel ? ` de chez ${c.brandLabel}` : "";
      const sku = c.sku ? ` ${c.sku}` : "";
      return `${c.name || "Produit"}${sku}${brand}`.trim();
    };

    const formatProductBlock = (c: Candidate) => {
      const lines: string[] = [];
      lines.push(`Nom : ${titleLine(c)}`);
      if (c.kind === "recorder") {
        lines.push(`Canaux : ${c.channels ?? "N/A"}`);
        lines.push(`PoE : ${c.poe ? "oui" : "non"}`);
      }
      if (c.kind === "camera") {
        lines.push(`Type : ${c.ip ? "IP" : "Coaxial/Analog"}`);
        lines.push(`PoE : ${c.poe ? "oui" : "non"}`);
      }
      lines.push(formatTTCLine(c.price));
      lines.push(`Lien : ${c.url}`);
      if (c.fiche_technique_url) lines.push(`Fiche technique : ${c.fiche_technique_url}`);
      return lines.join("\n");
    };

    const policy = `
RÈGLES OBLIGATOIRES:
- Ne propose JAMAIS de produits AJAX (toute la marque AJAX) dans les recommandations vidéosurveillance (caméras/enregistreurs/switch/alims).
- Ne JAMAIS inventer d’URL: utilise uniquement les liens fournis.
- Prix: toujours afficher en € TTC, sinon "voir page produit".
- Si l’utilisateur parle de X zones: expliquer "souvent entre X et 2X caméras" et demander combien il vise.
- Si NVR/IP: proposer uniquement caméras IP (pas coax).
- Réponse commerciale concise (pas de liste brute 1/2/3 en mode robot).
`.trim();

    const needSummary = `
BESOIN CLIENT (déduit):
- Enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- Caméras: ${need.wantsCameras ? "oui" : "non"}
- IP: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Zones: ${zones ?? "non précisé"}
- Plage caméras: ${cameraRange ? `${cameraRange.min} à ${cameraRange.max}` : "n/a"}
- Budget: ${budget ? `${budget} €` : "non précisé"}
`.trim();

    const recorderBlock = chosenRecorder ? `\n[PRODUIT ENREGISTREUR]\n${formatProductBlock(chosenRecorder)}\n` : "";
    const camerasBlock = cameraPicks.length
      ? `\n[CAMÉRAS À PROPOSER]\n${cameraPicks.map((c) => formatProductBlock(c)).join("\n\n")}\n`
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

    await supa.from("chat_sessions").update({ last_assistant_message: reply, state }).eq("id", conversationId);

    const headers = new Headers({ "content-type": "application/json" });
    if (!cookieId) setCookie(headers, "cp_conversation_id", conversationId);

    return new Response(
      JSON.stringify({
        ok: true,
        conversationId,
        reply,
        rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
        ...(debug ? { debug: { need, state, chosenRecorder, cameraPicks } } : {}),
      }),
      { status: 200, headers }
    );
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
