// app/ai/api/chat/route.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openaiJson } from "@/lib/openai";

export const runtime = "nodejs";

type Need = {
  category?: "nvr" | "dvr" | "camera" | "alarm" | "other";
  channels_min?: number | null;
  poe_required?: boolean | null;
  camera_type?: "ip" | "analog" | null;
  brand?: string | null;
  budget_max?: number | null;
};

function json(res: any, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normalizeText(s: any) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire accents
    .replace(/[^\p{L}\p{N}\s\-\/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeTerms(input: string) {
  const norm = normalizeText(input);

  // on garde aussi les tokens de longueur 2 (ex: ip)
  const raw = norm.split(/\s+/).filter(Boolean);

  // stopwords minimal FR (on évite de polluer)
  const stop = new Set([
    "je", "jai", "j", "ai", "besoin", "d", "de", "du", "des", "un", "une", "pour",
    "avec", "sans", "et", "ou", "la", "le", "les", "a", "au", "aux", "en",
    "mon", "ma", "mes", "vos", "votre", "leurs", "ce", "cet", "cette",
  ]);

  const terms = raw
    .filter((t) => !stop.has(t))
    .filter((t) => t.length >= 2) // inclut "ip"
    .slice(0, 15);

  return terms;
}

/**
 * Extrait des besoins depuis la phrase utilisateur.
 * Réponse JSON stricte.
 */
async function extractNeed(input: string): Promise<Need> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const sys = `
Tu extrais des contraintes d'achat (vidéosurveillance) depuis une phrase client.
Réponds UNIQUEMENT en JSON valide, sans texte autour.

Schéma:
{
  "category": "nvr|dvr|camera|alarm|other",
  "channels_min": number|null,
  "poe_required": boolean|null,
  "camera_type": "ip|analog"|null,
  "brand": string|null,
  "budget_max": number|null
}

Règles:
- "enregistreur IP" => category:nvr, camera_type:ip
- "DVR" / "analogique" => category:dvr, camera_type:analog
- "PoE" => poe_required:true
- si non précisé => null
`;

  const out = await openaiJson("chat/completions", {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: sys.trim() },
      { role: "user", content: input },
    ],
    response_format: { type: "json_object" },
  });

  const content = out?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    return { category: "other" };
  }
}

function camprotectUrlFromSlug(slug?: string | null) {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  if (!slug) return null;
  return `${base}/product/${slug}`;
}

/**
 * Recherche catalogue:
 * - on récupère 250 produits (pas de filtre fragile)
 * - scoring en JS sur: name/ref/sku/slug + chunks
 * - fallback si 0 candidat: produit dont name contient enregistreur/nvr
 */
async function findCandidates(input: string, need: Need, limit = 6) {
  const sb = supabaseAdmin();
  const terms = makeTerms(input);

  // 1) produits (toujours)
  const { data: products, error } = await sb
    .from("products")
    .select("id, name, slug, url, product_reference, sku, brand, product_type, price, currency")
    .limit(250);

  if (error) throw new Error(error.message);
  if (!products?.length) return { candidates: [], debug: { terms, productsCount: 0, chunksCount: 0 } };

  // 2) chunks (optionnel)
  let chunks: any[] = [];
  if (terms.length) {
    const ors = terms.map((t) => `chunk.ilike.%${t}%`).join(",");
    const { data: c, error: ce } = await sb
      .from("product_chunks")
      .select("product_id, chunk")
      .or(ors)
      .limit(800);
    if (!ce && c) chunks = c;
  }

  const chunkByProduct = new Map<number, string[]>();
  for (const c of chunks) {
    const pid = Number(c.product_id);
    if (!chunkByProduct.has(pid)) chunkByProduct.set(pid, []);
    chunkByProduct.get(pid)!.push(String(c.chunk || ""));
  }

  // 3) scoring
  const normTerms = terms.map((t) => normalizeText(t));

  const scored = products.map((p: any) => {
    const pid = Number(p.id);
    const hay = normalizeText(
      [
        p.name,
        p.product_reference,
        p.sku,
        p.slug,
        p.brand,
        p.product_type,
        ...(chunkByProduct.get(pid) || []),
      ]
        .filter(Boolean)
        .join(" ")
    );

    let score = 0;

    for (const t of normTerms) {
      if (t && hay.includes(t)) score += 2;
    }

    // boosts “métier”
    if (need.category === "nvr") {
      if (hay.includes("nvr") || hay.includes("enregistreur")) score += 4;
      if (hay.includes("ip")) score += 2;
    }
    if (need.poe_required && hay.includes("poe")) score += 4;

    // si le client mentionne "4" ou "4 canaux" -> on booste si présent
    if (normalizeText(input).includes("4") && (hay.includes("4") || hay.includes("4ch") || hay.includes("4 canaux"))) {
      score += 2;
    }

    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  let candidates = scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.p);

  // 4) fallback si zéro: on sort les “enregistreurs/nvr”
  if (candidates.length === 0) {
    const fallback = products
      .filter((p: any) => {
        const n = normalizeText(p.name);
        return n.includes("enregistreur") || n.includes("nvr");
      })
      .slice(0, limit)
      .map((p: any) => p);

    candidates = fallback;
  }

  // ensure url
  candidates = candidates.map((p: any) => ({
    ...p,
    url: p.url || camprotectUrlFromSlug(p.slug),
  }));

  return {
    candidates,
    debug: {
      terms,
      productsCount: products.length,
      chunksCount: chunks.length,
    },
  };
}

function formatProductLine(p: any) {
  const ref = String(p.product_reference || p.sku || "").trim();
  const price =
    typeof p.price === "number" ? ` — ${p.price.toFixed(2)} ${(p.currency || "EUR").toString()}` : "";
  const url = p.url || null;
  return `- ${p.name}${ref ? ` — ${ref}` : ""}${price}${url ? `\n  ${url}` : ""}`;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const input = String(body?.input || "").trim();
  const debug = Boolean(body?.debug);

  if (!input) return json({ ok: false, error: "Missing input" }, 400);

  const need = await extractNeed(input);
  const { candidates, debug: searchDebug } = await findCandidates(input, need, 6);

  const context =
    candidates.length > 0
      ? `Produits CamProtect pertinents:\n${candidates.map(formatProductLine).join("\n")}`
      : "Aucun produit trouvé dans le catalogue.";

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const sys = `
Tu es un conseiller e-commerce CamProtect (vidéosurveillance).
Tu dois:
- proposer 1 à 3 produits maximum si disponibles dans le contexte
- expliquer brièvement pourquoi (usage réel)
- poser 1 à 3 questions si des infos manquent (budget, HDD, 4K, PoE, etc.)
- ne JAMAIS inventer un produit qui n'est pas dans le contexte
- toujours inclure les liens CamProtect fournis
`;

  const user = `
Demande client: ${input}

Besoins extraits (interne): ${JSON.stringify(need)}

${context}
`;

  const out = await openaiJson("chat/completions", {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: sys.trim() },
      { role: "user", content: user.trim() },
    ],
  });

  const reply = out?.choices?.[0]?.message?.content || "Je n’ai pas assez d’informations pour répondre.";

  return json({
    ok: true,
    reply,
    rag: {
      used: candidates.length > 0 ? 1 : 0,
      sources: candidates.map((p: any) => ({ id: p.id, url: p.url })),
    },
    debug: debug
      ? {
          need,
          search: searchDebug,
          candidates: candidates.map((p: any) => ({
            id: p.id,
            name: p.name,
            product_reference: p.product_reference,
            sku: p.sku,
            url: p.url,
          })),
        }
      : undefined,
  });
}
