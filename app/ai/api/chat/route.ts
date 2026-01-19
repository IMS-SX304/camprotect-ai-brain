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

  // prix HT en base (product) + fallback min variant
  price: number | null;
  min_variant_price?: number | null;

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
  wantsRecorder: boolean;
  wantsCameras: boolean;
  wantsPack: boolean;

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
    t.includes("tout compris");

  const wantsRecorder =
    wantsPack ||
    t.includes("enregistreur") ||
    t.includes("nvr") ||
    t.includes("dvr") ||
    t.includes("xvr");

  const wantsCameras =
    wantsPack ||
    t.includes("caméra") ||
    t.includes("camera") ||
    t.includes("caméras") ||
    t.includes("cameras");

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
    wantsPack,
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
  const compat = (row?.payload?.["compatibilité caméra"] || row?.payload?.compatibilite || row?.payload?.compatibility || "").toString().toLowerCase();
  const typeEnreg = (row?.payload?.["type d'enregistreur"] || "").toString().toLowerCase();

  return (
    name.includes("ip") ||
    name.includes("nvr") ||
    tech.includes("réseau") ||
    tech.includes("reseau") ||
    compat.includes("onvif") ||
    typeEnreg.includes("nvr")
  );
}

function inferIsPoE(row: any): boolean {
  const name = (row?.name || row?.payload?.name || "").toString().toLowerCase();
  const alim = (row?.payload?.alimentation || "").toString().toLowerCase();
  const ports = (row?.payload?.["port et connectivité"] || row?.payload?.["port et connectivite"] || "").toString().toLowerCase();
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

function titleLine(c: Candidate) {
  const brand = c.brandLabel ? ` de chez ${c.brandLabel}` : "";
  const sku = c.sku ? ` ${c.sku}` : "";
  return `${c.name || "Produit"}${sku}${brand}`.trim();
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

function mustFTLine(c: Candidate) {
  return c.fiche_technique_url ? `Fiche technique : ${c.fiche_technique_url}` : null;
}

function formatProductBlock(c: Candidate) {
  const lines: string[] = [];
  lines.push(`- ${titleLine(c)}`);
  if (c.kind === "recorder") {
    lines.push(`  Canaux : ${c.channels ?? "N/A"}  |  PoE : ${c.poe ? "oui" : "non"}  |  IP : ${c.ip ? "oui" : "non"}`);
  }
  if (c.kind === "camera") {
    lines.push(`  Type : ${c.ip ? "IP" : "Coaxial"}  |  PoE : ${c.poe ? "oui" : "non"}`);
  }
  lines.push(`  ${formatTTCLine(c)}`);
  lines.push(`  Lien : ${c.url}`);
  const ft = mustFTLine(c);
  if (ft) lines.push(`  ${ft}`);
  return lines.join("\n");
}

function pickBestRecorderForPack(recorders: Candidate[], channelsNeed: number, wantsPoE: boolean) {
  let pool = recorders
    .filter((r) => r.kind === "recorder")
    .filter((r) => typeof r.channels === "number" && (r.channels as number) >= channelsNeed)
    .filter((r) => r.ip); // pack default IP

  if (wantsPoE) pool = pool.filter((r) => r.poe);

  // tri: plus petit canaux, puis prix TTC
  pool.sort((a, b) => {
    const ca = a.channels ?? 9999;
    const cb = b.channels ?? 9999;
    if (ca !== cb) return ca - cb;

    const pa = finalPriceHT(a) ?? 999999;
    const pb = finalPriceHT(b) ?? 999999;
    return pa - pb;
  });

  return pool[0] ?? null;
}

function pickCamerasForPack(cameras: Candidate[], wantsPoE: boolean) {
  // pack IP uniquement (si NVR)
  let pool = cameras.filter((c) => c.kind === "camera" && c.ip);

  // si on veut PoE (pack), on filtre PoE
  if (wantsPoE) pool = pool.filter((c) => c.poe);

  // on garde celles qui ont un prix via produit OU via variantes
  pool = pool.filter((c) => typeof finalPriceHT(c) === "number");

  // tri prix croissant
  pool.sort((a, b) => (finalPriceHT(a)! - finalPriceHT(b)!));

  return pool.slice(0, 3);
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

    // session (state léger)
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

    // Load products
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(1200);

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
        const ip = inferIsIP(r);

        const minVar = minPriceByProductId.get(pid) ?? null;

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
          brandLabel: brandLabelFromRow(r),
        };
      })
      .filter((c) => c.url && c.name);

    const recordersAll = candidatesAll.filter((c) => c.kind === "recorder");
    const camerasAll = candidatesAll.filter((c) => c.kind === "camera");

    // ===== PACK PLANNER =====
    const zones = state.zones ?? null;
    const cameraRange = state.cameraRange ?? null;

    const camsTarget =
      state.requestedCameras ??
      (cameraRange?.target ?? null);

    const budget = state.budget ?? null;

    const effectiveCamsTarget = camsTarget ?? (zones ? cameraRange?.target : 4) ?? 4;

    // pack => PoE recommandé (installation simple)
    const wantsPoEForPack = need.wantsPoE || need.wantsPack;

    const pickedPackRecorder =
      need.wantsPack
        ? pickBestRecorderForPack(recordersAll, effectiveCamsTarget, wantsPoEForPack)
        : null;

    const pickedPackCameras =
      need.wantsPack
        ? pickCamerasForPack(camerasAll, wantsPoEForPack)
        : [];

    let estTotalTTC: number | null = null;
    if (pickedPackRecorder && pickedPackCameras.length) {
      const recHT = finalPriceHT(pickedPackRecorder) ?? 0;
      const camHT = finalPriceHT(pickedPackCameras[0]) ?? 0;
      estTotalTTC = Math.round((moneyTTC(recHT) + moneyTTC(camHT) * effectiveCamsTarget) * 100) / 100;
    }

    const ragSources = [
      ...(pickedPackRecorder ? [{ id: pickedPackRecorder.id, url: pickedPackRecorder.url }] : []),
      ...pickedPackCameras.map((c) => ({ id: c.id, url: c.url })),
    ].slice(0, 6);

    // --- réponse pack déterministe (toujours produits + FT si dispo) ---
    if (need.wantsPack) {
      const intro = zones
        ? `Pour couvrir ${zones} zones, on part souvent sur ${cameraRange?.min} à ${cameraRange?.max} caméras (selon angles et distances). Je vous propose une base simple et évolutive :`
        : `Je vous propose un kit complet simple et évolutif :`;

      const lines: string[] = [];
      lines.push(intro);
      lines.push("");
      lines.push("✅ Enregistreur proposé");
      lines.push(pickedPackRecorder ? formatProductBlock(pickedPackRecorder) : "- Aucun enregistreur trouvé dans le catalogue");
      lines.push("");

      lines.push("📷 Caméras IP compatibles (prix croissant)");
      if (pickedPackCameras.length) {
        pickedPackCameras.forEach((c, i) => {
          lines.push(`${i + 1}) ${formatProductBlock(c)}`);
        });
      } else {
        lines.push("- Je n’ai pas trouvé de caméras IP exploitables (prix manquant).");
      }

      if (estTotalTTC) {
        lines.push("");
        lines.push(`💶 Estimation (avec ${effectiveCamsTarget} caméras) : ${formatEUR(estTotalTTC)} € TTC`);
        if (budget) {
          lines.push(`Budget indiqué : ${budget} €`);
        }
      }

      lines.push("");
      lines.push("Pour affiner rapidement :");
      lines.push(`- Vous visez plutôt ${cameraRange ? `${cameraRange.min} à ${cameraRange.max}` : "combien"} caméras au total ?`);
      lines.push("- Installation : intérieur / extérieur (ou les deux) ?");
      lines.push("- Stockage : combien de jours d’archives souhaitez-vous (HDD déjà prévu ou non) ?");

      const headers = new Headers({ "content-type": "application/json" });
      if (!cookieId) setCookie(headers, "cp_conversation_id", conversationId);

      // optionnel: petite reformulation IA (mais sans casser le contenu)
      const final = lines.join("\n");

      await supa.from("chat_sessions").update({ last_assistant_message: final, state }).eq("id", conversationId);

      return new Response(
        JSON.stringify({
          ok: true,
          conversationId,
          reply: final,
          rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
          ...(debug
            ? {
                debug: {
                  need,
                  state,
                  pack: {
                    effectiveCamsTarget,
                    recorder: pickedPackRecorder,
                    cameras: pickedPackCameras,
                    estTotalTTC,
                  },
                },
              }
            : {}),
        }),
        { status: 200, headers }
      );
    }

    // Sinon: fallback au LLM (hors pack)
    const policy = `
RÈGLES OBLIGATOIRES:
- Ne propose JAMAIS de produits AJAX.
- Ne JAMAIS inventer d’URL.
- Prix: toujours en € TTC si possible.
- Si enregistreur IP/NVR => caméras IP uniquement.
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: policy },
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
        ...(debug ? { debug: { need, state } } : {}),
      }),
      { status: 200, headers }
    );
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
