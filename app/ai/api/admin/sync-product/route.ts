// app/ai/api/admin/sync-product/route.ts
import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { webflowJson, moneyToNumber } from "../../../../../lib/webflow";

export const runtime = "nodejs";

type Body = {
  webflowProductId: string;
};

function requireAdmin(req: Request) {
  const token = req.headers.get("x-admin-token") || "";
  const expected = process.env.ADMIN_TOKEN || "";
  return !!expected && token === expected;
}

function baseUrl() {
  return (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/+$/, "");
}

function productUrlFromSlug(slug?: string | null) {
  if (!slug) return null;
  return `${baseUrl()}/product/${slug}`;
}

function safeText(v: any): string | null {
  return typeof v === "string" ? v : null;
}

function safeJson(v: any) {
  return v && typeof v === "object" ? v : {};
}

export async function POST(req: Request) {
  try {
    if (!requireAdmin(req)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const webflowProductId = (body?.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const siteId = (process.env.WEBFLOW_SITE_ID || "").trim();
    if (!siteId) {
      return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
    }

    const supa = supabaseAdmin();

    /**
     * ✅ Webflow v2 eCommerce: endpoint "scopé site"
     * GET /v2/sites/{site_id}/products/{product_id}
     */
    const wf = await webflowJson(`sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

    const product = wf?.product;
    const skus = Array.isArray(wf?.skus) ? wf.skus : [];

    if (!product?.id || !product?.fieldData) {
      return Response.json(
        { ok: false, error: "Webflow product payload unexpected", details: wf },
        { status: 500 }
      );
    }

    const fd = product.fieldData;

    const slug = safeText(fd.slug);
    const name = safeText(fd.name) || "Produit";
    const brand = safeText(fd.fabricants) || safeText(fd.brand);
    const productReference = safeText(fd["product-reference"]) || safeText(fd["code-fabricant"]);
    const description = safeText(fd.description) || safeText(fd["description-mini"]);
    const metaDescription = safeText(fd["meta-description"]);
    const beneficeCourt = safeText(fd["benefice-court"]);
    const altword = safeText(fd.altword);

    const url = productUrlFromSlug(slug);

    const payload = {
      webflow: {
        productId: product.id,
        cmsLocaleId: product.cmsLocaleId,
        updated: product.lastUpdated,
        published: product.lastPublished,
      },
      fieldData: fd,
    };

    // 1) Upsert product + récupérer products.id (bigint)
    const { data: upsertedProduct, error: upsertProdErr } = await supa
      .from("products")
      .upsert(
        {
          webflow_product_id: product.id,
          slug,
          name,
          brand,
          product_reference: productReference,
          url,
          description,
          meta_description: metaDescription,
          benefice_court: beneficeCourt,
          altword,
          payload,
        },
        { onConflict: "webflow_product_id" }
      )
      .select("id, webflow_product_id, slug, url")
      .single();

    if (upsertProdErr || !upsertedProduct?.id) {
      return Response.json(
        {
          ok: false,
          error: "Supabase products upsert failed",
          details: upsertProdErr?.message || "unknown",
        },
        { status: 500 }
      );
    }

    const productDbId = upsertedProduct.id as number;

    // 2) Upsert variants (skus) avec product_id NOT NULL ✅
    let insertedVariants = 0;

    for (const sku of skus) {
      const skuId = sku?.id;
      const skuFd = sku?.fieldData || {};
      if (!skuId) continue;

      const unitPrice = moneyToNumber(skuFd.price) ?? null;
      const currency = (skuFd.price?.unit || skuFd.price?.currency || "EUR") as string;
      const optionValues = safeJson(skuFd["sku-values"]);

      const variantRow = {
        product_id: productDbId,
        webflow_sku_id: String(skuId),
        sku: safeText(skuFd.sku) || null,
        name: safeText(skuFd.name) || null,
        slug: safeText(skuFd.slug) || null,
        price: unitPrice,
        currency,
        option_values: optionValues,
        payload: {
          webflow: { skuId: skuId, productId: product.id },
          fieldData: skuFd,
        },
      };

      const { error: upsertVarErr } = await supa
        .from("product_variants")
        .upsert(variantRow, { onConflict: "webflow_sku_id" });

      if (upsertVarErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upsertVarErr.message },
          { status: 500 }
        );
      }

      insertedVariants += 1;
    }

    return Response.json({
      ok: true,
      webflowProductId,
      product: {
        id: productDbId,
        slug: upsertedProduct.slug,
        url: upsertedProduct.url,
      },
      inserted_variants: insertedVariants,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
