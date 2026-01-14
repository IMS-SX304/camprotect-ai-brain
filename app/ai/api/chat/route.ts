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
  price_ht: number | null;
  currency: string | null;
  product_type: string | null;
  product_kind: string | null; // 'camera' | 'recorder' | 'switch' | 'alarm' | ...
  brand: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  payload: any;

  channels: number | null;
  isIP: boolean;
  isPoE: boolean;
  score: number;
};

const TVA = 0.2;

function priceTTC(ht: number | null): number | null {
  if (typeof ht !== "number") return null;
  return Math.round(ht * (1 + TVA) * 100) / 100;
}

function fmtEuro(n: number) {
  // affichage simple "166,45"
  return n.toFixed(2).replace(".", ",");
}

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  return m ? Number(m[1]) : null;
}

function tokenize(input: string): string[] {
  return (input || "")
    .toLowerCase()
    .replace(/[’'"]/g, " ")
    .replace(/[^a-z0-9àâäéèêëîïôöùûüç\s-]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function detectNeed(input: string) {
  const t = (input || "").toLowerCase();

  const wantsRecorder = t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");
  const wantsCamera = t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  const wantsIP = t.includes("ip") || t.includes("nvr");
  const wantsPoE = t.includes("poe");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const requestedChannels = m ? Number(m[1]) : null;

  const mb = t.match(/(\d{2,6})\s*(€|eur|euro)/i);
  const budget = mb ? Number(mb[1]) : null;

  return {
    wantsRecorder,
    wantsCamera,
    wantsIP,
    wantsPoE,
    requestedChannels: requestedChannels && requestedChannels > 0 ? requestedChannels : null,
    budget: Number.isFinite(budget as any) ? (budget as number) : null,
  };
}

function buildHaystack(r: any): string {
  const p = r?.payload || {};
  const parts: string[] = [];
  parts.push((r?.name || p?.name || "").toString());
  parts.push((r?.sku || p?.["product-reference"] || p?.["code-fabricant"] || "").toString());
  parts.push((r?.product_type || p?.["type-de-produit"] || "").toString());
  parts.push((r?.product_kind || "").toString());
  parts.push((r?.brand || p?.fabricant || p?.fabricants || "").toString());
  parts.push((p?.altword || "").toString());
  parts.push((p?.["description-mini"] || "").toString());
  parts.push((p?.description || "").toString());
  return parts.join(" ").toLowerCase();
}

function detectIPPoE(hay: string) {
  const isPoE = hay.includes("poe") || hay.includes("802.3af") || hay.includes("802.3at") || hay.includes("802.3bt");
  const isIP = hay.includes("ip") || hay.includes("onvif") || hay.includes("rtsp") || hay.includes("nvr");
  return { isIP, isPoE };
}

function scoreCandidate(tokens: string[], hay: string) {
  let score = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    if (hay.includes(tok)) score += 2;

    const looksLikeRef = /[0-9]/.test(tok) && (tok.includes("-") || tok.includes("/") || tok.length >= 6);
    if (looksLikeRef && hay.includes(tok)) score += 6;
  }
  if (hay.includes("poe")) score += 1;
  if (hay.includes("ip") || hay.includes("onvif")) score += 1;
  return score;
}

function isRecorder(c: Candidate) {
  const hay = buildHaystack(c);
  return c.product_kind === "recorder" || hay.includes("enregistreur") || hay.includes("nvr") || hay.includes("dvr") || hay.includes("xvr");
}

function isCamera(c: Candidate) {
  const hay = buildHaystack(c);
  return c.product_kind === "camera" || hay.includes("caméra") || hay.includes("camera") || hay.includes("dome") || hay.includes("bullet") || hay.includes("tubulaire");
}

function excludeNonIPCameras(c: Candidate, need: ReturnType<typeof detectNeed>) {
  // Si user veut des caméras IP, on exclut Ajax MotionCam / alarm / détecteurs
  if (!need.wantsIP) return true;

  const hay = buildHaystack(c);
  if (c.product_kind === "alarm") return false;
  if (hay.includes("ajax") || hay.includes("motioncam") || hay.includes("jeweller")) return false;

  return true;
}

function pickRecorder(recorders: Candidate[], requestedChannels: number | null) {
  if (!recorders.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  const sorted = [...recorders].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ca = a.channels ?? 9999;
    const cb = b.channels ?? 9999;
    return ca - cb;
  });

  if (!requestedChannels) return { exact: sorted[0] ?? null, fallback: null };

  const exact = sorted.find((c) => c.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = sorted
    .filter((c) => typeof c.channels === "number" && (c.channels as number) > requestedChannels)
    .sort((a, b) => (a.channels as number) - (b.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

function pickCameras(cameras: Candidate[], max = 3) {
  // prix croissant TTC si possible, sinon score
  const sorted = [...cameras].sort((a, b) => {
    const pa = priceTTC(a.price_ht) ?? Number.POSITIVE_INFINITY;
    const pb = priceTTC(b.price_ht) ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return b.score - a.score;
  });
  return sorted.slice(0, max);
}

function commercialLabel(c: Candidate) {
  const name = (c.name || "").trim();
  const sku = (c.sku || "").trim();
  const brand = (c.brand || "").trim();

  // on évite la répétition si déjà dans le name
  const hasSkuInName = sku && name.toLowerCase().includes(sku.toLowerCase());
  const parts: string[] = [];
  if (name) parts.push(name);
  if (sku && !hasSkuInName) parts.push(sku);
  if (brand) parts.push(`de chez ${brand}`);
  return parts.join(" ");
}

function benefitShort(c: Candidate) {
  const b = c.payload?.benefice_court || c.payload?.["benefice-court"];
  if (typeof b === "string" && b.trim()) return b.trim();
  // fallback factuel ultra court
  if (isRecorder(c)) return "Enregistrement fiable et accès à distance.";
  if (isCamera(c)) return "Surveillance IP, image nette, vision nuit selon modèle.";
  return "Produit adapté à la vidéosurveillance.";
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

    // ---- mémoire (si table conversations existe)
    let pinnedRecorderId: number | null = null;
    try {
      const { data: conv } = await supa
        .from("conversations")
        .select("id,picked_recorder_id")
        .eq("id", conversationId)
        .maybeSingle();

      if (conv?.picked_recorder_id) pinnedRecorderId = Number(conv.picked_recorder_id) || null;
    } catch {
      // pas bloquant
    }

    // ---- load catalogue
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,product_kind,brand,sku,fiche_technique_url,payload")
      .limit(2000);

    if (error) return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });

    const rows = Array.isArray(raw) ? raw : [];
    const tokens = tokenize(input);

    const all: Candidate[] = rows
      .map((r: any) => {
        const id = Number(r.id);
        if (!Number.isFinite(id)) return null;

        const hay = buildHaystack(r);
        const score = scoreCandidate(tokens, hay);
        const { isIP, isPoE } = detectIPPoE(hay);

        const name = (r.name || r.payload?.name || "").toString().trim() || null;
        const sku = (r.sku || r.payload?.["product-reference"] || r.payload?.["code-fabricant"] || "").toString().trim() || null;
        const brand = (r.brand || r.payload?.fabricant || r.payload?.fabricants || "").toString().trim() || null;

        return {
          id,
          name,
          url: (r.url || null) as string | null,
          price_ht: typeof r.price === "number" ? r.price : null,
          currency: (r.currency || "EUR") as string | null,
          product_type: (r.product_type || null) as string | null,
          product_kind: (r.product_kind || null) as string | null,
          brand,
          sku,
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,
          payload: r.payload || null,

          channels: extractChannels(name || ""),
          isIP,
          isPoE,
          score,
        } as Candidate;
      })
      .filter(Boolean) as Candidate[];

    let recorders = all.filter(isRecorder);
    let cameras = all.filter(isCamera);

    // filtres IP / PoE demandés
    if (need.wantsIP) {
      recorders = recorders.filter((c) => c.isIP);
      cameras = cameras.filter((c) => c.isIP);
    }
    if (need.wantsPoE) {
      cameras = cameras.filter((c) => c.isPoE || c.isIP);
    }

    // exclure MotionCam / Ajax si "caméras IP"
    cameras = cameras.filter((c) => excludeNonIPCameras(c, need));

    // ---- pick recorder (pinned > exact > fallback)
    let chosenRecorder: Candidate | null = null;
    let pickedMode: "pinned" | "exact" | "fallback" | "none" = "none";

    if (pinnedRecorderId) {
      chosenRecorder = recorders.find((r) => r.id === pinnedRecorderId) || null;
      if (chosenRecorder) pickedMode = "pinned";
    }

    if (!chosenRecorder && need.wantsRecorder) {
      const picked = pickRecorder(recorders, need.requestedChannels);
      chosenRecorder = picked.exact || picked.fallback;
      pickedMode = picked.exact ? "exact" : picked.fallback ? "fallback" : "none";
    }

    // ---- pick cameras
    const chosenCameras = need.wantsCamera ? pickCameras(cameras, 3) : [];

    // ---- persist pinned recorder
    if (chosenRecorder) {
      try {
        await supa.from("conversations").upsert(
          { id: conversationId, picked_recorder_id: chosenRecorder.id, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      } catch {
        // pas bloquant
      }
    }

    // ---- build strict context for the model (DB truth only)
    const recorderLine = (c: Candidate) => {
      const ttc = priceTTC(c.price_ht);
      const priceStr = ttc !== null ? `${fmtEuro(ttc)} € TTC` : "Prix : voir page produit";
      const ft = c.fiche_technique_url ? c.fiche_technique_url : "N/A";
      return [
        `LABEL: ${commercialLabel(c)}`,
        `CANALS: ${c.channels ?? "N/A"}`,
        `POE: ${c.isPoE ? "oui" : "non"}`,
        `PRICE_TTC: ${priceStr}`,
        `URL: ${c.url || "N/A"}`,
        `FT: ${ft}`,
        `BENEFIT: ${benefitShort(c)}`,
      ].join("\n");
    };

    const cameraLine = (c: Candidate) => {
      const ttc = priceTTC(c.price_ht);
      const priceStr = ttc !== null ? `${fmtEuro(ttc)} € TTC` : "Prix : voir page produit";
      const ft = c.fiche_technique_url ? c.fiche_technique_url : "N/A";
      return [
        `LABEL: ${commercialLabel(c)}`,
        `PRICE_TTC: ${priceStr}`,
        `URL: ${c.url || "N/A"}`,
        `FT: ${ft}`,
        `BENEFIT: ${benefitShort(c)}`,
      ].join("\n");
    };

    const missingRecorder = need.wantsRecorder && !chosenRecorder;
    const missingCams = need.wantsCamera && chosenCameras.length === 0;

    const policy = `
RÈGLES ABSOLUES:
- Tu ne DOIS utiliser que les produits fournis dans [RECORDER] et [CAMERAS].
- Interdiction d'inventer des produits, des liens, des prix, des fiches techniques.
- Affiche TOUJOURS les prix en TTC quand présents (PRICE_TTC).
- Titre commercial obligatoire: "Nom + Référence + de chez Marque".
- Si le client demande X canaux et qu'on n'a pas exact:
  => dire explicitement: "Nous n’avons pas X canaux, la meilleure alternative est Y canaux."
- Caméras: 3 propositions, triées prix croissant, chacune = LABEL + PRICE_TTC + URL + FT + BENEFIT.
- Finir par 3 questions groupées (caméras en place / jours d’archive & HDD / résolution & budget).
- Ne propose JAMAIS MotionCam / Ajax si la demande est "caméras IP".
`.trim();

    const needBlock = `
BESOIN:
- wantsRecorder=${need.wantsRecorder}
- wantsCamera=${need.wantsCamera}
- wantsIP=${need.wantsIP}
- wantsPoE=${need.wantsPoE}
- requestedChannels=${need.requestedChannels ?? "N/A"}
- budget=${need.budget ?? "N/A"}
- pickedMode=${pickedMode}
`.trim();

    const recorderBlock = chosenRecorder ? `[RECORDER]\n${recorderLine(chosenRecorder)}\n` : "";
    const camerasBlock = chosenCameras.length
      ? `[CAMERAS]\n${chosenCameras.map((c, i) => `CAM_${i + 1}\n${cameraLine(c)}`).join("\n\n")}\n`
      : "";

    const availabilityNote = `
DISPONIBILITÉ:
- missingRecorder=${missingRecorder}
- missingCams=${missingCams}
`.trim();

    const context = `
${policy}

${needBlock}
${availabilityNote}

${recorderBlock}
${camerasBlock}
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: context },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    // sources = uniquement produits choisis
    const ragSources = [chosenRecorder, ...chosenCameras]
      .filter(Boolean)
      .map((c) => ({ id: (c as Candidate).id, url: (c as Candidate).url }));

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              pickedMode,
              pinnedRecorderId,
              picked: {
                recorder: chosenRecorder ? { id: chosenRecorder.id, url: chosenRecorder.url, label: commercialLabel(chosenRecorder) } : null,
                cameras: chosenCameras.map((c) => ({ id: c.id, url: c.url, label: commercialLabel(c) })),
              },
              counts: {
                recorders: recorders.length,
                cameras: cameras.length,
              },
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
