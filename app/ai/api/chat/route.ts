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
  price: number | null; // HT (en base)
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url?: string | null;

  // classification
  isRecorder: boolean;
  isCamera: boolean;
  isIP: boolean;
  isPoE: boolean;
  channels: number | null;

  // debug
  score?: number;
};

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function extractChannels(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(canaux|ch|voies)\b/i);
  if (m1) return Number(m1[1]);
  return null;
}

function priceTTC(priceHT: number | null, tva = 0.2): number | null {
  if (typeof priceHT !== "number") return null;
  // arrondi à 2 décimales
  return Math.round(priceHT * (1 + tva) * 100) / 100;
}

function detectNeed(input: string) {
  const t = (input || "").toLowerCase();

  const wantsRecorder =
    t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");

  const wantsCamera =
    t.includes("caméra") || t.includes("camera") || t.includes("caméras") || t.includes("cameras");

  // IP peut concerner caméra et/ou enregistreur
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

function buildHaystack(r: any): string {
  const parts: string[] = [];
  const name = (r?.name || r?.payload?.name || "").toString();
  parts.push(name);

  const sku = (r?.sku || r?.payload?.["product-reference"] || r?.payload?.["code-fabricant"] || "").toString();
  parts.push(sku);

  const productType = (r?.product_type || r?.payload?.["type-de-produit"] || "").toString();
  parts.push(productType);

  const altword = (r?.payload?.altword || "").toString();
  parts.push(altword);

  const descMini = (r?.payload?.["description-mini"] || "").toString();
  parts.push(descMini);

  const desc = (r?.payload?.description || "").toString();
  parts.push(desc);

  return parts.join(" ").toLowerCase();
}

function classifyCandidate(hay: string, name: string) {
  const isRecorder =
    hay.includes("enregistreur") || hay.includes("nvr") || hay.includes("dvr") || hay.includes("xvr");

  const isCamera =
    hay.includes("caméra") || hay.includes("camera") || hay.includes("dôme") || hay.includes("dome") || hay.includes("bullet") || hay.includes("tubulaire");

  const isIP = hay.includes("ip") || hay.includes("nvr") || hay.includes("onvif") || hay.includes("rtsp");
  const isPoE = hay.includes("poe") || hay.includes("802.3af") || hay.includes("802.3at");

  const channels = extractChannels(name);

  return { isRecorder, isCamera, isIP, isPoE, channels };
}

function scoreCandidate(tokens: string[], hay: string) {
  // scoring simple: +2 par token exact présent, +5 si token ressemble à une ref (contient - ou / ou chiffres)
  let score = 0;

  for (const tok of tokens) {
    if (!tok) continue;
    if (hay.includes(tok)) score += 2;

    // bonus “référence”
    const looksLikeRef = /[0-9]/.test(tok) && (tok.includes("-") || tok.includes("/") || tok.length >= 6);
    if (looksLikeRef && hay.includes(tok)) score += 5;
  }

  // petits bonus business
  if (hay.includes("poe")) score += 1;
  if (hay.includes("ip")) score += 1;

  return score;
}

function pickRecorder(cands: Candidate[], requestedChannels: number | null) {
  if (!cands.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  // On trie d’abord par score desc, puis par canaux asc (pour prendre le plus petit qui convient)
  const sorted = [...cands].sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;
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

function pickCameras(cands: Candidate[], max = 3) {
  const sorted = [...cands].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return sorted.slice(0, max);
}

function safeLinkLabel(name: string | null, sku: string | null) {
  const n = (name || "").trim();
  const s = (sku || "").trim();
  if (n && s) return `${n} — ${s}`;
  return n || s || "Voir produit";
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

    // 1) Load products
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(1000);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows = Array.isArray(raw) ? raw : [];
    const tokens = tokenize(input);

    // 2) Build candidates with classification + scoring
    const all: Candidate[] = rows
      .map((r: any) => {
        const pid = Number(r.id);
        if (!Number.isFinite(pid)) return null;

        const name = (r.name || r.payload?.name || "").toString() || null;
        const url = (r.url || null) as string | null;
        const sku = (r.sku || r.payload?.["product-reference"] || r.payload?.["code-fabricant"] || null) as string | null;
        const product_type = (r.product_type || r.payload?.["type-de-produit"] || null) as string | null;

        const hay = buildHaystack(r);
        const cls = classifyCandidate(hay, name || "");

        const score = scoreCandidate(tokens, hay);

        return {
          id: pid,
          name,
          url,
          price: typeof r.price === "number" ? r.price : null,
          currency: (r.currency || "EUR") as string | null,
          product_type,
          sku,
          fiche_technique_url: (r.fiche_technique_url || null) as string | null,

          isRecorder: cls.isRecorder,
          isCamera: cls.isCamera,
          isIP: cls.isIP,
          isPoE: cls.isPoE,
          channels: cls.channels,

          score,
        } as Candidate;
      })
      .filter(Boolean) as Candidate[];

    // 3) Split: recorders & cameras
    let recorders = all.filter((c) => c.isRecorder);
    let cameras = all.filter((c) => c.isCamera);

    // Filtre IP/PoE si demandé
    if (need.wantsIP) {
      // si demande IP, on privilégie IP (mais on garde une fallback plus bas)
      recorders = recorders.filter((c) => c.isIP);
      cameras = cameras.filter((c) => c.isIP);
    }
    if (need.wantsPoE) {
      recorders = recorders.filter((c) => c.isPoE);
      cameras = cameras.filter((c) => c.isPoE || c.isIP); // caméras IP PoE souvent marquées IP; on évite de vider à tort
    }

    // fallback si trop strict => on relâche progressivement
    if (!recorders.length) recorders = all.filter((c) => c.isRecorder);
    if (!cameras.length) cameras = all.filter((c) => c.isCamera);

    const pickedRecorder = need.wantsRecorder ? pickRecorder(recorders, need.requestedChannels) : { exact: null, fallback: null };
    const chosenRecorder = pickedRecorder.exact || pickedRecorder.fallback;

    const chosenCameras = need.wantsCamera ? pickCameras(cameras, 3) : [];

    // 4) Build rag sources (urls only, no hallucination)
    const sources: { id: number; url: string | null }[] = [];
    for (const c of [chosenRecorder, ...chosenCameras].filter(Boolean) as Candidate[]) {
      sources.push({ id: c.id, url: c.url || null });
    }

    // 5) If nothing found => polite answer (no invention)
    if (!chosenRecorder && chosenCameras.length === 0) {
      const reply = await chatCompletion([
        { role: "system" as const, content: CAMPROTECT_SYSTEM_PROMPT },
        {
          role: "system" as const,
          content:
            `RÈGLE: si aucun produit n'est trouvé, tu l'annonces clairement et tu poses 2-3 questions. ` +
            `Interdiction d'inventer une URL, un prix ou un produit.`,
        },
        { role: "user" as const, content: input },
      ]);

      return Response.json({
        ok: true,
        conversationId,
        reply,
        rag: { used: 0, sources: [] },
        ...(debug ? { debug: { need, candidatesCount: all.length } } : {}),
      });
    }

    // 6) Format blocks for the model (strictly from DB)
    const TVA = 0.2;

    const formatProductBlock = (c: Candidate) => {
      const ttc = priceTTC(c.price, TVA);
      const priceLine = ttc !== null ? `${ttc.toFixed(2)} ${(c.currency || "EUR")}` : "Voir page produit";
      const linkLine = c.url ? c.url : "N/A";
      const ftLine = c.fiche_technique_url ? c.fiche_technique_url : "N/A";

      return [
        `ID: ${c.id}`,
        `Nom: ${c.name || "N/A"}`,
        `SKU: ${c.sku || "N/A"}`,
        `Type: ${c.product_type || "N/A"}`,
        `Canaux: ${c.channels ?? "N/A"}`,
        `IP: ${c.isIP ? "oui" : "non"}`,
        `PoE: ${c.isPoE ? "oui" : "non"}`,
        `Prix TTC: ${priceLine}`,
        `URL EXACTE: ${linkLine}`,
        `FICHE TECHNIQUE: ${ftLine}`,
      ].join("\n");
    };

    const policy = `
FORMAT DE RÉPONSE (E-COMMERCE):
- Réponds en français, ton pro.
- Ne JAMAIS inventer un lien, un prix, une fiche technique.
- Utilise UNIQUEMENT les champs "URL EXACTE" et "FICHE TECHNIQUE" fournis.
- Si la demande contient "caméras" + "enregistreur": propose 1 enregistreur + 2 à 3 caméras (si dispo).
- Prix: toujours en TTC (TVA 20% déjà appliquée dans "Prix TTC").
- Si l'utilisateur demande X canaux et que tu proposes plus: dis explicitement "Nous n’avons pas X canaux, meilleure alternative = Y canaux".
- Pas de liste brute "1/2/3" trop sèche.
  => Termine par 2-3 questions utiles regroupées (compatibilité caméras, HDD + jours d'archives, résolution/budget).
- La fiche technique est un lien: tu peux la proposer en une ligne courte ("📄 Fiche technique: ...") sans redire "consultez".
`.trim();

    const needSummary = `
BESOIN CLIENT:
- Caméras demandées: ${need.wantsCamera ? "oui" : "non"}
- Enregistreur demandé: ${need.wantsRecorder ? "oui" : "non"}
- IP: ${need.wantsIP ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés: ${need.requestedChannels ?? "non précisé"}
`.trim();

    const blocks: string[] = [];
    if (chosenRecorder) {
      const label = pickedRecorder.exact ? "PRODUIT EXACT (ENREGISTREUR)" : "ALTERNATIVE (ENREGISTREUR)";
      blocks.push(`[${label}]\n${formatProductBlock(chosenRecorder)}\n`);
    }
    if (chosenCameras.length) {
      blocks.push(
        `[CAMÉRAS SUGGÉRÉES]\n` +
          chosenCameras.map((c, i) => `--- Caméra ${i + 1} ---\n${formatProductBlock(c)}`).join("\n\n")
      );
    }

    const context = `${policy}\n\n${needSummary}\n\n${blocks.join("\n")}`.trim();

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
      rag: { used: sources.length ? 1 : 0, sources },
      ...(debug
        ? {
            debug: {
              need,
              picked: {
                recorder: chosenRecorder
                  ? { id: chosenRecorder.id, url: chosenRecorder.url, channels: chosenRecorder.channels, price_ttc: priceTTC(chosenRecorder.price, 0.2) }
                  : null,
                cameras: chosenCameras.map((c) => ({ id: c.id, url: c.url })),
              },
              candidates: {
                recordersTop: recorders
                  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                  .slice(0, 6)
                  .map((c) => ({ id: c.id, name: c.name, url: c.url, score: c.score })),
                camerasTop: cameras
                  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                  .slice(0, 6)
                  .map((c) => ({ id: c.id, name: c.name, url: c.url, score: c.score })),
              },
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
