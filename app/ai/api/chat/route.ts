// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, CAMPROTECT_SYSTEM_PROMPT } from "@/lib/openai";

export const runtime = "nodejs";

type ChatBody = {
  input: string;
  conversationId?: string;
  debug?: boolean;
};

type Compat = {
  family?: string;   // NVR/DVR/XVR/CAMERA/SWITCH/AJAX/KIT/OTHER
  tech?: string;     // IP/COAX/RADIO/OTHER
  poe?: boolean;
  channels?: number | null;
  poe_ports?: number | null;
  storage_bays?: number | null;
  cable?: string | null; // RJ45/KX6
  power?: string | null; // POE/12V/230V/BATTERY
  onvif?: boolean | null;
  max_mp?: number | null;
};

type Candidate = {
  id: number;
  name: string | null;
  url: string | null;
  price: number | null; // HT
  currency: string | null;
  product_type: string | null;
  sku: string | null;
  fiche_technique_url: string | null;
  payload: any;

  compat: Compat;

  // derived
  final_price_ht: number | null;
  final_price_ttc: number | null;
};

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normLower(s: any): string {
  if (s === null || s === undefined) return "";
  return String(s).toLowerCase().trim();
}

function extractChannelsFromText(text: string): number | null {
  const t = normLower(text);
  const m = t.match(/(\d{1,2})\s*(canaux|ch|voies)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------- NEED DETECTION ----------
function detectNeed(input: string) {
  const t = normLower(input);

  const wantsRecorder = t.includes("enregistreur") || t.includes("nvr") || t.includes("dvr") || t.includes("xvr");
  const wantsCamera = t.includes("caméra") || t.includes("camera");
  const wantsSwitch = t.includes("switch");
  const wantsAjax = t.includes("ajax");

  const wantsIP = t.includes("ip") || t.includes("réseau") || t.includes("reseau") || t.includes("nvr");
  const wantsCoax = t.includes("coax") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd") || t.includes("dvr") || t.includes("xvr");
  const wantsPoE = t.includes("poe");

  const m = t.match(/(\d{1,2})\s*(cam(é|e)ras?|camera|canaux|ch|voies)\b/i);
  const requestedChannels = m ? Number(m[1]) : null;

  return {
    wantsRecorder,
    wantsCamera,
    wantsSwitch,
    wantsAjax,
    wantsIP,
    wantsCoax,
    wantsPoE,
    requestedChannels: requestedChannels && requestedChannels > 0 ? requestedChannels : null,
  };
}

// ---------- PICKER ----------
function pickBest(candidates: Candidate[], requestedChannels: number | null) {
  if (!candidates.length) return { exact: null as Candidate | null, fallback: null as Candidate | null };

  if (!requestedChannels) {
    // plus petit nombre de canaux non-null, sinon 1er
    const sorted = [...candidates].sort((a, b) => {
      const ca = typeof a.compat.channels === "number" ? a.compat.channels : 9999;
      const cb = typeof b.compat.channels === "number" ? b.compat.channels : 9999;
      return ca - cb;
    });
    return { exact: sorted[0] ?? null, fallback: null };
  }

  const exact = candidates.find((c) => c.compat.channels === requestedChannels) ?? null;
  if (exact) return { exact, fallback: null };

  const higher = candidates
    .filter((c) => typeof c.compat.channels === "number" && (c.compat.channels as number) > requestedChannels)
    .sort((a, b) => (a.compat.channels as number) - (b.compat.channels as number));

  return { exact: null, fallback: higher[0] ?? null };
}

function formatMoneyEUR(v: number) {
  // format FR simple
  return v.toFixed(2).replace(".", ",");
}

function addTTC(ht: number | null, vat = 0.2) {
  if (typeof ht !== "number") return null;
  return Math.round(ht * (1 + vat) * 100) / 100;
}

function buildCandidate(r: any, minVarPrice: number | null): Candidate {
  const pid = Number(r.id);
  const name = (r.name || r.payload?.name || "").toString() || null;

  // compat (depuis sync)
  const compat: Compat = (r.payload?.compat || {}) as Compat;

  // fallback channels si compat pas remplie
  if (compat.channels === undefined || compat.channels === null) {
    compat.channels = extractChannelsFromText(name || "");
  }

  // prix final HT : products.price sinon min variante
  const final_price_ht =
    typeof r.price === "number" ? r.price : (typeof minVarPrice === "number" ? minVarPrice : null);

  const final_price_ttc = addTTC(final_price_ht);

  return {
    id: Number.isFinite(pid) ? pid : 0,
    name,
    url: (r.url || null) as string | null,
    price: typeof r.price === "number" ? r.price : null,
    currency: (r.currency || "EUR") as string | null,
    product_type: (r.product_type || null) as string | null,
    sku: (r.sku || null) as string | null,
    fiche_technique_url: (r.fiche_technique_url || null) as string | null,
    payload: r.payload || {},
    compat,
    final_price_ht,
    final_price_ttc,
  };
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

    // 1) Load products (on prend payload + fiche tech)
    const { data: raw, error } = await supa
      .from("products")
      .select("id,name,url,price,currency,product_type,sku,fiche_technique_url,payload")
      .limit(500);

    if (error) {
      return Response.json({ ok: false, error: "Supabase query failed", details: error.message }, { status: 500 });
    }

    const rows = Array.isArray(raw) ? raw : [];
    const productIds = rows.map((r: any) => Number(r.id)).filter((n) => Number.isFinite(n));

    // 2) min price per product from variants
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

    // 3) Build candidates
    const candidatesAll: Candidate[] = rows.map((r: any) => {
      const pid = Number(r.id);
      const minVar = minPriceByProductId.get(pid) ?? null;
      return buildCandidate(r, minVar);
    });

    // 4) Filter based on need (v1: on part sur “enregistreur” sinon on étendra)
    // On garde volontairement simple pour commencer caméra/enregistreur.
    let candidates = candidatesAll;

    if (need.wantsAjax) {
      candidates = candidates.filter((c) => normLower(c.compat.family) === "ajax" || normLower(c.payload?.raccordement) === "radio");
    } else if (need.wantsRecorder) {
      candidates = candidates.filter((c) => {
        const fam = normLower(c.compat.family);
        return fam === "nvr" || fam === "dvr" || fam === "xvr";
      });
    } else if (need.wantsCamera) {
      candidates = candidates.filter((c) => normLower(c.compat.family) === "camera");
    } else if (need.wantsSwitch) {
      candidates = candidates.filter((c) => normLower(c.compat.family) === "switch");
    }

    // refine tech/poe
    if (need.wantsIP) candidates = candidates.filter((c) => normLower(c.compat.tech) === "ip" || normLower(c.compat.family) === "nvr");
    if (need.wantsCoax) candidates = candidates.filter((c) => normLower(c.compat.tech) === "coax" || normLower(c.compat.family) === "dvr" || normLower(c.compat.family) === "xvr");
    if (need.wantsPoE) candidates = candidates.filter((c) => !!c.compat.poe);

    // fallback if empty (avoid "no results" too often)
    if (!candidates.length && need.wantsRecorder) {
      candidates = candidatesAll.filter((c) => {
        const fam = normLower(c.compat.family);
        return fam === "nvr" || fam === "dvr" || fam === "xvr";
      });
    }

    const picked = pickBest(candidates, need.requestedChannels);
    const ragSources = candidates.slice(0, 6).map((c) => ({ id: c.id, url: c.url }));

    const chosen = picked.exact || picked.fallback;

    // ---------- Prompt policy ----------
    const policy = `
RÈGLES DE RÉPONSE:
- Si produit exact => titre "✅ Produit recommandé"
- Si pas exact => titre "ℹ️ Alternative proposée" ET phrase explicite: "Nous n’avons pas de X canaux..., voici l’alternative Y canaux."
- Affiche TOUJOURS : Nom, Canaux, PoE, Prix TTC, Lien.
- Prix TTC = HT * 1.20 (TVA 20%).
- Si fiche_technique_url existe => ajouter une ligne "📄 Fiche technique : <lien>"
- N’invente jamais d’URL. Utilise uniquement l’URL fournie.
- Après la reco : poser des questions utiles, groupées (compatibilité / stockage / objectif), pas en liste brute "1/2/3" si possible.
`.trim();

    const needSummary = `
BESOIN CLIENT (déduit):
- cherche enregistreur: ${need.wantsRecorder ? "oui" : "non"}
- IP: ${need.wantsIP ? "oui" : "non"}
- COAX: ${need.wantsCoax ? "oui" : "non"}
- PoE: ${need.wantsPoE ? "oui" : "non"}
- Canaux demandés: ${need.requestedChannels ?? "non précisé"}
`.trim();

    const formatChosen = (c: Candidate) => {
      const priceTtc = typeof c.final_price_ttc === "number" ? `${formatMoneyEUR(c.final_price_ttc)} € TTC` : "voir page produit";
      const ft = c.fiche_technique_url ? `📄 Fiche technique : ${c.fiche_technique_url}` : "";
      return [
        `Nom : ${c.name || "N/A"}`,
        `Canaux : ${typeof c.compat.channels === "number" ? c.compat.channels : "N/A"}`,
        `PoE : ${c.compat.poe ? "oui" : "non"}`,
        `Prix TTC : ${priceTtc}`,
        `Lien : ${c.url || "N/A"}`,
        ft ? ft : null,
      ].filter(Boolean).join("\n");
    };

    const exactBlock = picked.exact ? `\n[PRODUIT EXACT]\n${formatChosen(picked.exact)}\n` : "";
    const fallbackBlock = picked.fallback ? `\n[PRODUIT ALTERNATIF]\n${formatChosen(picked.fallback)}\n` : "";

    const context = `
${policy}

${needSummary}
${exactBlock}
${fallbackBlock}
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
      rag: { used: chosen ? 1 : 0, sources: ragSources },
      ...(debug
        ? {
            debug: {
              need,
              picked: {
                exact: picked.exact ? { id: picked.exact.id, url: picked.exact.url, compat: picked.exact.compat, ttc: picked.exact.final_price_ttc } : null,
                fallback: picked.fallback ? { id: picked.fallback.id, url: picked.fallback.url, compat: picked.fallback.compat, ttc: picked.fallback.final_price_ttc } : null,
              },
              candidates: candidates.slice(0, 6).map((c) => ({
                id: c.id,
                name: c.name,
                url: c.url,
                compat: c.compat,
                ttc: c.final_price_ttc,
                fiche_technique_url: c.fiche_technique_url,
              })),
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: e?.message || String(e) }, { status: 500 });
  }
}
