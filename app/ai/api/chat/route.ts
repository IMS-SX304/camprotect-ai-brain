// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";
import { cookies } from "next/headers";

export const runtime = "nodejs";

type ChatBody = {
  input?: string;
  debug?: boolean;
  action?: "reset" | "close" | "reopen";
};

type Candidate = {
  id: number;
  name: string | null;
  url: string | null;
  price_ht: number | null;
  currency: string | null;

  product_type: string | null;
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
const COOKIE_NAME = "cp_conv_id";

function priceTTC(ht: number | null): number | null {
  if (typeof ht !== "number") return null;
  return Math.round(ht * (1 + TVA) * 100) / 100;
}
function fmtEuro(n: number) {
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
    .slice(0, 20);
}

function detectNeed(input: string) {
  const t = (input || "").toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");
  const wantsCamera =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

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
  parts.push((r?.product_type || "").toString());
  parts.push((r?.brand || p?.fabricant || p?.fabricants || "").toString());
  parts.push((p?.altword || "").toString());
  parts.push((p?.["description-mini"] || "").toString());
  parts.push((p?.description || "").toString());
  parts.push((p?.slug || "").toString());
  return parts.join(" ").toLowerCase();
}

function detectIPPoE(hay: string) {
  const isPoE =
    hay.includes("poe") ||
    hay.includes("802.3af") ||
    hay.includes("802.3at") ||
    hay.includes("802.3bt");
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

function isAjaxProduct(hay: string) {
  return hay.includes("ajax") || hay.includes("jeweller") || hay.includes("fibra") || hay.includes("motioncam");
}
function isRecorderHay(hay: string) {
  return hay.includes("enregistreur") || hay.includes("nvr") || hay.includes("dvr") || hay.includes("xvr");
}
function isCameraHay(hay: string) {
  return (
    hay.includes("caméra") ||
    hay.includes("camera") ||
    hay.includes("dome") ||
    hay.includes("bullet") ||
    hay.includes("tubulaire") ||
    hay.includes("varifocale") ||
    hay.includes("ir")
  );
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
  if (buildHaystack(c).includes("nvr") || buildHaystack(c).includes("dvr") || buildHaystack(c).includes("xvr")) {
    return "Enregistrement fiable et accès à distance.";
  }
  if (buildHaystack(c).includes("cam")) return "Image nette et vision nocturne selon modèle.";
  return "Produit adapté à la vidéosurveillance.";
}

async function getOptionMap(fieldSlug: string) {
  const supa = supabaseAdmin();
  const { data, error } = await supa
    .from("webflow_option_map")
    .select("option_id,option_name")
    .eq("field_slug", fieldSlug)
    .limit(500);

  if (error || !Array.isArray(data)) return new Map<string, string>();
  const m = new Map<string, string>();
  for (const r of data as any[]) {
    if (r?.option_id && r?.option_name) m.set(String(r.option_id), String(r.option_name));
  }
  return m;
}

async function ensureConversation(supa: ReturnType<typeof supabaseAdmin>, id: string, scope: string) {
  await supa.from("conversations").upsert(
    { id, scope, updated_at: new Date().toISOString() },
    { onConflict: "id" }
  );
}

async function addMessage(
  supa: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  meta?: any
) {
  await supa.from("conversation_messages").insert({
    conversation_id: conversationId,
    role,
    content,
    meta: meta ?? null,
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as ChatBody | null;
    const input = (body?.input || "").trim();
    const debug = !!body?.debug;

    const jar = await cookies();
    let conversationId = jar.get("cp_conv_id")?.value || null;

    const action = body?.action;
    const supa = supabaseAdmin();

    if (action === "reset") {
      conversationId = crypto.randomUUID();
      jar.set(COOKIE_NAME, conversationId, { httpOnly: true, sameSite: "lax", path: "/" });
      await ensureConversation(supa, conversationId, "general");
      return Response.json({ ok: true, conversationId, reset: true });
    }

    if (!conversationId) {
      conversationId = crypto.randomUUID();
      jar.set(COOKIE_NAME, conversationId, { httpOnly: true, sameSite: "lax", path: "/" });
    }

    if (action === "close") {
      await supa.from("conversations").update({ closed_at: new Date().toISOString() }).eq("id", conversationId);
      return Response.json({ ok: true, conversationId, closed: true });
    }
    if (action === "reopen") {
      await supa.from("conversations").update({ closed_at: null }).eq("id", conversationId);
      return Response.json({ ok: true, conversationId, reopened: true });
    }

    if (!input) return Response.json({ ok: false, error: "Missing input" }, { status: 400 });

    const need = detectNeed(input);

    // ✅ scope video : on exclut Ajax (mais surtout, on filtre en SQL)
    const tokens = tokenize(input);
    const fabricantsMap = await getOptionMap("fabricants"); // mapping id -> name

    await ensureConversation(supa, conversationId, "video");
    await addMessage(supa, conversationId, "user", input);

    // ✅ Filtrage SQL pour éviter 504 : on ne charge pas tout le catalogue
    // On charge :
    // - recorders si besoin enregistreur OU si input contient nvr/dvr/xvr/enregistreur
    // - cameras si besoin caméra OU si input contient camera/caméra
    const wantRec = need.wantsRecorder || /(\bnvr\b|\bdvr\b|\bxvr\b|enregistreur)/i.test(input);
    const wantCam = need.wantsCamera || /(caméra|camera)/i.test(input);

    const baseSelect = "id,name,url,price,currency,product_type,brand,sku,fiche_technique_url,payload";

    async function fetchByKeyword(kind: "rec" | "cam") {
      const q = kind === "rec"
        ? "name.ilike.%nvr%,name.ilike.%dvr%,name.ilike.%xvr%,name.ilike.%enregistreur%"
        : "name.ilike.%caméra%,name.ilike.%camera%,name.ilike.%dome%,name.ilike.%bullet%,name.ilike.%tubulaire%";

      // on limite fort pour éviter timeout
      const { data, error } = await supa
        .from("products")
        .select(baseSelect)
        .or(q)
        .limit(400);

      if (error) throw new Error(`Supabase query failed: ${error.message}`);
      return Array.isArray(data) ? data : [];
    }

    const [rawRec, rawCam] = await Promise.all([
      wantRec ? fetchByKeyword("rec") : Promise.resolve([]),
      wantCam ? fetchByKeyword("cam") : Promise.resolve([]),
    ]);

    // si l’utilisateur est vague, on prend un petit set général (utile)
    let raw = [...rawRec, ...rawCam];
    if (!raw.length) {
      const { data, error } = await supa.from("products").select(baseSelect).limit(300);
      if (error) throw new Error(`Supabase query failed: ${error.message}`);
      raw = Array.isArray(data) ? data : [];
    }

    // Dédup par id
    const seen = new Set<number>();
    const rows = raw.filter((r: any) => {
      const id = Number(r?.id);
      if (!Number.isFinite(id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    let all: Candidate[] = rows.map((r: any) => {
      const id = Number(r.id);
      const hay = buildHaystack(r);
      const { isIP, isPoE } = detectIPPoE(hay);
      const score = scoreCandidate(tokens, hay);

      // ✅ brand : si c’est un ID d’option Webflow, on le convertit
      const p = r.payload || {};
      const rawBrandId = String(r.brand || p.fabricant || p.fabricants || "").trim();
      const mappedBrand = fabricantsMap.get(rawBrandId) || rawBrandId || null;

      const name = (r.name || p.name || "").toString().trim() || null;
      const sku = (r.sku || p["product-reference"] || p["code-fabricant"] || "").toString().trim() || null;

      return {
        id,
        name,
        url: (r.url || null) as string | null,
        price_ht: typeof r.price === "number" ? r.price : null,
        currency: (r.currency || "EUR") as string | null,
        product_type: (r.product_type || null) as string | null,
        brand: mappedBrand,
        sku,
        fiche_technique_url: (r.fiche_technique_url || null) as string | null,
        payload: p,
        channels: extractChannels(name || ""),
        isIP,
        isPoE,
        score,
      };
    });

    // ✅ Exclusion Ajax sur toute la sélection
    all = all.filter((c) => !isAjaxProduct(buildHaystack(c)));

    let recorders = all.filter((c) => isRecorderHay(buildHaystack(c)));
    let cameras = all.filter((c) => isCameraHay(buildHaystack(c)));

    if (need.wantsIP) {
      recorders = recorders.filter((c) => c.isIP);
      cameras = cameras.filter((c) => c.isIP);
    }
    if (need.wantsPoE) {
      recorders = recorders.filter((c) => c.isPoE || c.isIP);
      cameras = cameras.filter((c) => c.isPoE || c.isIP);
    }

    const picked = need.wantsRecorder ? pickRecorder(recorders, need.requestedChannels) : { exact: null, fallback: null };
    const chosenRecorder = picked.exact || picked.fallback;
    const chosenCameras = need.wantsCamera ? pickCameras(cameras, 3) : [];

    const ragSources = [chosenRecorder, ...chosenCameras].filter(Boolean).map((c: any) => ({ id: c.id, url: c.url }));

    const recorderBlock = chosenRecorder
      ? `RECORDER:
LABEL: ${commercialLabel(chosenRecorder)}
CANALS: ${chosenRecorder.channels ?? "N/A"}
POE: ${chosenRecorder.isPoE ? "oui" : "non"}
PRICE_TTC: ${
          priceTTC(chosenRecorder.price_ht) !== null
            ? `${fmtEuro(priceTTC(chosenRecorder.price_ht) as number)} € TTC`
            : "Prix : voir page produit"
        }
URL: ${chosenRecorder.url || "N/A"}
FT: ${chosenRecorder.fiche_technique_url || "N/A"}
BENEFIT: ${benefitShort(chosenRecorder)}
`
      : `RECORDER: NONE`;

    const camerasBlock = chosenCameras.length
      ? `CAMERAS (price ascending):
${chosenCameras
  .map((c, i) => {
    const ttc = priceTTC(c.price_ht);
    return `CAM_${i + 1}:
LABEL: ${commercialLabel(c)}
PRICE_TTC: ${ttc !== null ? `${fmtEuro(ttc)} € TTC` : "Prix : voir page produit"}
URL: ${c.url || "N/A"}
FT: ${c.fiche_technique_url || "N/A"}
BENEFIT: ${benefitShort(c)}
`;
  })
  .join("\n")}`
      : `CAMERAS: NONE`;

    const policy = `
RÈGLES ABSOLUES:
- Tu ne dois utiliser QUE les produits fournis dans RECORDER et CAMERAS.
- Interdiction d'inventer produits/liens/prix/FT.
- Prix toujours TTC quand présent (PRICE_TTC).
- Format commercial: "Nom + Référence + de chez Marque" + prix TTC.
- Si canaux demandés non dispo: l’indiquer clairement et proposer la meilleure alternative.
- Caméras: 3 propositions, triées prix croissant, chacune avec LABEL, PRICE_TTC, URL, FT, BENEFIT.
- Finir par 3 questions regroupées (caméras existantes / jours d’archive & HDD / résolution & budget).
- Contexte video: interdiction de proposer Ajax.
`.trim();

    const needBlock = `
BESOIN:
wantsRecorder=${need.wantsRecorder}
wantsCamera=${need.wantsCamera}
wantsIP=${need.wantsIP}
wantsPoE=${need.wantsPoE}
requestedChannels=${need.requestedChannels ?? "N/A"}
budget=${need.budget ?? "N/A"}
`.trim();

    const messages = [
      { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
      { role: "system" as const, content: `${policy}\n\n${needBlock}\n\n${recorderBlock}\n\n${camerasBlock}` },
      { role: "user" as const, content: input },
    ];

    const reply = await chatCompletion(messages);

    await addMessage(supa, conversationId, "assistant", reply, {
      recorderId: chosenRecorder?.id ?? null,
      cameraIds: chosenCameras.map((c) => c.id),
    });

    return Response.json({
      ok: true,
      conversationId,
      reply,
      rag: { used: ragSources.length ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              counts: { all: all.length, recorders: recorders.length, cameras: cameras.length },
              picked: {
                recorder: chosenRecorder ? { id: chosenRecorder.id, url: chosenRecorder.url, brand: chosenRecorder.brand } : null,
                cameras: chosenCameras.map((c) => ({ id: c.id, url: c.url, brand: c.brand })),
              },
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
