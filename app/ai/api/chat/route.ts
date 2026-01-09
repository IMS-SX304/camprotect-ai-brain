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

function clampInt(n: any, def: number, min: number, max: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

/**
 * Extrait des besoins depuis une phrase utilisateur.
 * On fait simple (et robuste) : le modèle renvoie un JSON Need.
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

/**
 * Recherche SQL “hybride simple”:
 * - On cherche dans products (name, product_reference/sku/slug)
 * - et dans product_chunks.chunk (RAG text)
 * On score naïvement par présence des termes.
 */
async function findCandidates(input: string, need: Need, limit = 6) {
  const sb = supabaseAdmin();

  // mots clés utiles
  const q = input.trim().toLowerCase();
  const terms = q
    .replace(/[^\p{L}\p{N}\s\-\/]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12);

  // Filtre catégorie : on s’appuie sur payload/product_type si dispo
  // (ça reste souple car tous les champs ne sont pas forcément normalisés)
  const mustBeNvr = need.category === "nvr" ? true : false;

  // 1) Récupère une base de produits "potentiels"
  // Note: on ne fait pas de joint lourd; on tire 200 max puis on score côté JS.
  let query = sb
    .from("products")
    .select("id, name, slug, url, product_reference, sku, brand, product_type, price, currency, payload")
    .limit(250);

  if (mustBeNvr) {
    // Tentative de filtre : product_type contient nvr / enregistreur / ip
    query = query.or(
      "product_type.ilike.%nvr%,product_type.ilike.%enregistreur%,payload->>type.ilike.%nvr%,payload->>type.ilike.%enregistreur%"
    );
  }

  const { data: products, error } = await query;
  if (error) throw new Error(error.message);

  if (!products?.length) return [];

  // 2) Récupère des chunks correspondant au texte (limité)
  // On récupère des chunks qui contiennent l’un des termes.
  let chunks: any[] = [];
  if (terms.length) {
    // construit un OR ilike sur chunk
    const ors = terms.map((t) => `chunk.ilike.%${t}%`).join(",");
    const { data: c, error: ce } = await sb
      .from("product_chunks")
      .select("product_id, chunk")
      .or(ors)
      .limit(600);
    if (!ce && c) chunks = c;
  }

  const chunkByProduct = new Map<number, string[]>();
  for (const c of chunks) {
    const pid = Number(c.product_id);
    if (!chunkByProduct.has(pid)) chunkByProduct.set(pid, []);
    chunkByProduct.get(pid)!.push(String(c.chunk || ""));
  }

  // 3) Score
  const scored = products.map((p: any) => {
    const hay =
      [
        p.name,
        p.product_reference,
        p.sku,
        p.slug,
        p.brand,
        p.product_type,
        ...(chunkByProduct.get(Number(p.id)) || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += 2;
    }

    // Boost si on a un match “enregistreur/ip/poe/4”
    if (need.category === "nvr" && (hay.includes("nvr") || hay.includes("enregistreur"))) score += 3;
    if (need.camera_type === "ip" && hay.includes("ip")) score += 2;
    if (need.poe_required && hay.includes("poe")) score += 3;
    if (need.channels_min && hay.includes(String(need.channels_min))) score += 2;

    return { p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((x) => x.score > 0)
    .slice(0, limit)
    .map((x) => x.p);
}

function formatProductLine(p: any) {
  const ref = (p.product_reference || p.sku || "").trim();
  const price =
    typeof p.price === "number"
      ? ` — ${p.price.toFixed(2)} ${(p.currency || "EUR").toString()}`
      : "";
  const url = p.url || (p.slug ? `${(process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "")}/product/${p.slug}` : null);

  return `- ${p.name}${ref ? ` — ${ref}` : ""}${price}${url ? `\n  ${url}` : ""}`;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const input = String(body?.input || "").trim();
  const debug = Boolean(body?.debug);

  if (!input) return json({ ok: false, error: "Missing input" }, 400);

  const need = await extractNeed(input);
  const candidates = await findCandidates(input, need, 6);

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const context =
    candidates.length > 0
      ? `Produits CamProtect pertinents:\n${candidates.map(formatProductLine).join("\n")}`
      : "Aucun produit trouvé dans le catalogue.";

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
    rag: { used: candidates.length > 0 ? 1 : 0, sources: candidates.map((p: any) => ({ id: p.id, url: p.url })) },
    debug: debug
      ? {
          need,
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
