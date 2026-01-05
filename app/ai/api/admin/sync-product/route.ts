// app/ai/api/admin/sync-product/route.ts

import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";
import {
  buildProductUrl,
  getWebflowProductWithSkus,
  priceToCents,
} from "../../../../../lib/webflow";

export const runtime = "nodejs";

type SyncBody = {
  productId: string; // Webflow product id
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SyncBody;
    const productId = (body.productId || "").trim();
    if (!productId) {
      return Response.json({ ok: false, error: "Missing productId" }, { status: 400 });
    }

    const supa = supabaseAdmin();
    const wf = await getWebflowProductWithSkus(productId);

    const p = wf.product;
    const fd = p.fieldData || {};
    const slug = (fd.slug || "").trim();
    if (!slug) {
      return Response.json({ ok: false, error: "Webflow product has no slug" }, { status: 400 });
    }

    const productUrl = buildProductUrl(slug);

    // 1) Upsert product
    const productRow = {
      webflow_product_id: p.id,
      slug,
      name: fd.name ?? null,
      product_reference: fd["product-reference"] ?? null,
      description: fd.description ?? null,
      description_complete: fd["description-complete"] ?? null,
      bullet_points: fd["bullet-point"] ?? null,
      fiche_technique_url: fd["fiche-technique-du-produit"]?.url ?? null,
      payload: fd,
      updated_at: new Date().toISOString(),
    };

    const upProduct = await supa
      .from("products")
      .upsert(productRow, { onConflict: "webflow_product_id" })
      .select("id, webflow_product_id, slug")
      .single();

    if (upProduct.error) {
      return Response.json({ ok: false, error: upProduct.error.message }, { status: 500 });
    }

    const dbProductId = upProduct.data.id;

    // 2) Upsert variants
    const defaultSkuId = fd["default-sku"] ?? null;

    const variants = wf.skus.map((s) => {
      const sfd = s.fieldData || {};
      return {
        webflow_sku_id: s.id,
        product_id: dbProductId,
        webflow_product_id: p.id,
        sku: sfd.sku ?? null,
        name: sfd.name ?? null,
        price_cents: priceToCents(sfd.price ?? null),
        currency: sfd.price?.unit ?? "EUR",
        variant_values: sfd["sku-values"] ?? null,
        is_default: defaultSkuId ? s.id === defaultSkuId : false,
        image_url: sfd["main-image"]?.url ?? null,
        updated_at: new Date().toISOString(),
      };
    });

    const upVariants = await supa
      .from("product_variants")
      .upsert(variants, { onConflict: "webflow_sku_id" });

    if (upVariants.error) {
      return Response.json({ ok: false, error: upVariants.error.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      product: { id: p.id, slug, url: productUrl },
      variants_count: variants.length,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
