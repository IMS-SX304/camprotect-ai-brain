// app/ai/api/admin/sync-product/route.ts
import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { webflowGetProduct, moneyToNumber } from "../../../../../lib/webflow";

export const runtime = "nodejs";

type Body = {
  webflowProductId: string;
};

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function getBaseUrl() {
  // Mets juste https://www.camprotect.fr dans CAMPROTECT_BASE_URL
  const base = requireEnv("CAMPROTECT_BASE_URL").replace(/\/+$/, "");
  return base;
}

export async function POST(req: Request) {
  try {
    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    if (!body.webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const siteId = requireEnv("WEBFLOW_SITE_ID");
    const baseUrl = getBaseUrl();

    // 1) Webflow get product (inclut product + skus)
    const wf = await webflowGetProduct(siteId, body.webflowProductId);

    const product = wf?.product;
    const skus = Array.isArray(wf?.skus) ? wf.skus : [];

    if (!product?.id || !product?.fieldData) {
      return Response.json({ ok: false, error: "Webflow product malformed" }, { status: 500 });
    }

    const fd = product.fieldData;

    const slug: string | null = fd.slug || null;
    const url = slug ? `${baseUrl}/product/${slug}` : null;

    const payload = {
      webflow: {
        product,
        skus,
      },
      fieldData: fd,
    };

    // 2) Upsert PRODUCT (clé = webflow_product_id)
    const supa = supabaseAdmin();

    const productUpsert = {
      webflow_product_id: product.id,
      slug: slug,
      url,
      name: fd.name || null,
      brand: fd.fabricants || null, // tu peux remapper vers un champ texte si tu veux le libellé plutôt qu’un id
      product_reference: fd["product-reference"] || fd["code-fabricant"] || null,
      altword: fd.altword || null,
      benefice_court: fd["benefice-court"] || null,
      meta_description: fd["meta-description"] || null,
      description_complete: fd["description-complete"] || null,
      fiche_technique_url: fd["fiche-technique-du-produit"]?.url || null,
      payload,
    };

    const { error: upErr } = await supa
      .from("products")
      .upsert(productUpsert, { onConflict: "webflow_product_id" });

    if (upErr) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upErr.message },
        { status: 500 }
      );
    }

    // 3) Récupère l'ID interne du produit (bigint) -> pour product_variants.product_id NOT NULL
    const { data: pRow, error: pSelErr } = await supa
      .from("products")
      .select("id, webflow_product_id, slug, url, name")
      .eq("webflow_product_id", product.id)
      .maybeSingle();

    if (pSelErr || !pRow?.id) {
      return Response.json(
        { ok: false, error: "Supabase product re-select failed", details: pSelErr?.message || "Not found" },
        { status: 500 }
      );
    }

    // 4) Upsert VARIANTS
    let upsertedVariants = 0;

    for (const skuItem of skus) {
      const sfd = skuItem?.fieldData || {};
      const price = moneyToNumber(sfd.price);
      const currency = (sfd.price?.unit || sfd.price?.currency || "EUR").toUpperCase();

      const variantPayload = {
        webflowSku: skuItem,
        skuFieldData: sfd,
      };

      const variantUpsert = {
        webflow_sku_id: skuItem.id,
        webflow_product_id: product.id,
        product_id: pRow.id,
        sku: sfd.sku || null,
        name: sfd.name || null,
        slug: sfd.slug || null,
        price: price,
        currency,
        option_values: sfd["sku-values"] || null, // map { optionId: enumId }
        image_url: sfd["main-image"]?.url || null,
        payload: variantPayload,
      };

      const { error: vErr } = await supa
        .from("product_variants")
        .upsert(variantUpsert, { onConflict: "webflow_sku_id" });

      if (vErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: vErr.message },
          { status: 500 }
        );
      }

      upsertedVariants++;
    }

    return Response.json({
      ok: true,
      webflowProductId: product.id,
      supabaseProductId: pRow.id,
      upsertedVariants,
      url,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
