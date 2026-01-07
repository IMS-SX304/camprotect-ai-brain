// app/ai/api/chat/route.ts

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function normalizeRef(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function skuCandidates(input: string) {
  const raw = input.trim();
  const n = normalizeRef(raw);

  // ex: DS-7616NXI-I2-S -> DS7616NXII2S
  const withDashes = raw.toUpperCase().replace(/\s+/g, "");
  const withSlashes = withDashes.replace(/-/g, "/");

  const set = new Set<string>([
    raw,
    withDashes,
    withSlashes,
    n,
  ]);

  return Array.from(set).filter(Boolean).slice(0, 12);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const input = String(body?.input || "").trim();
    const debug = !!body?.debug;

    if (!input) {
      return Response.json({ ok: false, error: "Missing input" }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const candidates = skuCandidates(input);

    // 1) exact sur product_reference (si tu l’as)
    // 2) sinon match SKU variantes (si produit à variantes)
    // 3) sinon fallback slug/name ilike
    const norm = normalizeRef(input);

    // A) match direct products.product_reference
    let { data: p1, error: e1 } = await sb
      .from("products")
      .select("webflow_product_id, name, slug, url, brand, product_reference, meta_description, benefice_court, altword")
      .eq("product_reference", input)
      .limit(1);

    // B) match normalisé sur product_reference (si l’utilisateur écrit différemment)
    if (!p1?.length) {
      const { data: p2 } = await sb
        .from("products")
        .select("webflow_product_id, name, slug, url, brand, product_reference, meta_description, benefice_court, altword")
        .ilike("product_reference", `%${input}%`)
        .limit(1);
      p1 = p2 || p1;
    }

    // C) match sur variantes SKU
    let variantHit: any = null;
    if (!p1?.length) {
      for (const c of candidates) {
        const { data: v } = await sb
          .from("product_variants")
          .select("webflow_product_id, sku, price, currency, option_values, url")
          .eq("sku", c)
          .limit(1);

        if (v && v.length) {
          variantHit = v[0];
          break;
        }
      }
    }

    // Si variante trouvée -> récupérer le produit associé
    if (!p1?.length && variantHit?.webflow_product_id) {
      const { data: p3 } = await sb
        .from("products")
        .select("webflow_product_id, name, slug, url, brand, product_reference, meta_description, benefice_court, altword")
        .eq("webflow_product_id", variantHit.webflow_product_id)
        .limit(1);
      p1 = p3 || p1;
    }

    const product = p1?.[0] || null;

    if (!product) {
      return Response.json({
        ok: true,
        reply:
          "Je ne le trouve pas dans le catalogue CamProtect. Pouvez-vous préciser la référence exacte ou le type de produit (NVR, caméra, alarme) ?",
        rag: { used: 0, sources: [] },
        ...(debug
          ? {
              debug: {
                input,
                normalized: norm,
                skuCandidates: candidates,
                supabaseErrors: [e1?.message].filter(Boolean),
              },
            }
          : {}),
      });
    }

    // Prix : si variante hit => prix de la variante
    const priceText =
      variantHit?.price != null
        ? `${variantHit.price} ${variantHit.currency || "EUR"}`
        : "prix disponible sur la page produit";

    const url = product.url || (product.slug ? `https://www.camprotect.fr/product/${product.slug}` : null);

    return Response.json({
      ok: true,
      reply:
        `✅ ${product.name}\n` +
        `Référence: ${product.product_reference || "—"}\n` +
        `Prix: ${priceText}\n` +
        (url ? `Lien CamProtect : ${url}` : `Lien CamProtect : non disponible`),
      rag: { used: 1, sources: [{ id: product.webflow_product_id, similarity: 1 }] },
      ...(debug
        ? {
            debug: {
              input,
              extractedSku: input,
              skuCandidates: candidates,
              variantHit,
              product,
            },
          }
        : {}),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: String(e?.message || e) }, { status: 500 });
  }
}
