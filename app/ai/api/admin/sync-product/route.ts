// app/ai/api/admin/sync-product/route.ts

import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { getWebflowProductWithSkus, moneyToNumber } from "../../../../../lib/webflow";

export const runtime = "nodejs";

type Body = {
  webflowProductId: string;
};

function requireAdmin(req: Request) {
  const token = req.headers.get("x-admin-token") || "";
  const expected = process.env.ADMIN_TOKEN || "";
  return expected && token === expected;
}

function camprotectProductUrl(slug: string) {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/+$/, "");
  return `${base}/product/${slug}`;
}

export async function POST(req: Request) {
  try {
    if (!requireAdmin(req)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const webflowProductId = (body.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    // 1) Récupérer le produit + ses SKUs (variantes) depuis Webflow
    const wf = await getWebflowProductWithSkus(webflowProductId);

    const productFields = wf.product?.fieldData || {};
    const slug = String(productFields.slug || "").trim();
    const name = String(productFields.name || "").trim();

    if (!slug || !name) {
      return Response.json(
        { ok: false, error: "Webflow product missing slug or name", details: { slug, name } },
        { status: 500 }
      );
    }

    // Champs utiles (à adapter si tes clés changent)
    const brand = productFields.fabricants ?? productFields.brand ?? null;
    const productReference = productFields["product-reference"] ?? productFields["code-fabricant"] ?? null;

    const description = productFields.description ?? productFields["description-mini"] ?? null;
    const metaDescription = productFields["meta-description"] ?? null;
    const beneficeCourt = productFields["benefice-court"] ?? null;
    const altword = productFields.altword ?? null;

    const url = camprotectProductUrl(slug);

    // On stocke le reste en payload (super utile pour nourrir l’IA)
    const payload = productFields;

    const supa = supabaseAdmin();

    // 2) Upsert produit
    const productRow = {
      webflow_product_id: webflowProductId,
      slug,
      name,
      brand: typeof brand === "string" ? brand : null,
      product_reference: typeof productReference === "string" ? productReference : null,
      url,
      description: typeof description === "string" ? description : null,
      meta_description: typeof metaDescription === "string" ? metaDescription : null,
      benefice_court: typeof beneficeCourt === "string" ? beneficeCourt : null,
      altword: typeof altword === "string" ? altword : null,
      payload,
    };

    const { error: upsertProdErr } = await supa
      .from("products")
      .upsert(productRow, { onConflict: "webflow_product_id" });

    if (upsertProdErr) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upsertProdErr.message },
        { status: 500 }
      );
    }

    // 3) Upsert variantes (skus)
    const skus = Array.isArray(wf.skus) ? wf.skus : [];
    const variantRows = skus.map((s) => {
      const f = s.fieldData || {};
      const price = moneyToNumber(f.price);
      const currency = (f.price?.unit || f.price?.currency || "EUR").toUpperCase();

      return {
        webflow_sku_id: s.id,
        webflow_product_id: webflowProductId,
        sku: typeof f.sku === "string" ? f.sku : null,
        name: typeof f.name === "string" ? f.name : null,
        slug: typeof f.slug === "string" ? f.slug : null,
        price,
        currency,
        option_values: f["sku-values"] ?? null,
        payload: f,
      };
    });

    if (variantRows.length > 0) {
      const { error: upsertVarErr } = await supa
        .from("product_variants")
        .upsert(variantRows, { onConflict: "webflow_sku_id" });

      if (upsertVarErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upsertVarErr.message },
          { status: 500 }
        );
      }
    }

    return Response.json({
      ok: true,
      webflowProductId,
      product: { slug, name, url },
      inserted_variants: variantRows.length,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
