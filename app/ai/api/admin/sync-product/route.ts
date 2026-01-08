// app/ai/api/admin/sync-product/route.ts

import { webflowJson, moneyToNumber } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function assertAdmin(req: Request) {
  const admin = process.env.ADMIN_TOKEN;
  const got = req.headers.get("x-admin-token");
  if (!admin || !got || got !== admin) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function productUrlFromSlug(slug?: string | null) {
  const base = (process.env.CAMPROTECT_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !slug) return null;
  return `${base}/product/${slug}`;
}

export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) {
    return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const webflowProductId = body?.webflowProductId as string | undefined;

  if (!webflowProductId) {
    return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
  }

  const sb = supabaseAdmin();

  try {
    // 1) Récupérer produit + SKUs (IMPORTANT pour variantes)
    const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

    const product = data?.product;
    const skus = data?.skus || [];

    if (!product?.id) {
      return Response.json({ ok: false, error: "Product not found in Webflow response" }, { status: 404 });
    }

    const fd = product.fieldData || {};
    const slug = fd.slug ?? null;

    // 2) Upsert product
    const productRow: any = {
      webflow_product_id: product.id,
      slug,
      name: fd.name ?? null,
      brand: fd.fabricants ?? fd.brand ?? null, // chez toi c’est un ID de collection
      product_reference: fd["product-reference"] ?? fd.productReference ?? null,
      url: productUrlFromSlug(slug),
      altword: fd.altword ?? null,
      benefice_court: fd["benefice-court"] ?? null,
      meta_description: fd["meta-description"] ?? null,
      description: fd.description ?? null,
      description_complete: fd["description-complete"] ?? null,
      bullet_point: fd["bullet-point"] ?? null,
      raw_field_data: fd,
    };

    const upProd = await sb
      .from("products")
      .upsert(productRow, { onConflict: "webflow_product_id" })
      .select("id, webflow_product_id")
      .single();

    if (upProd.error) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upProd.error.message },
        { status: 500 }
      );
    }

    const dbProductId = upProd.data.id;

    // 3) Upsert variants (skus)
    const variantRows = skus.map((s: any) => {
      const sfd = s.fieldData || {};
      const priceNum = moneyToNumber(sfd.price);

      return {
        product_id: dbProductId,
        webflow_product_id: product.id,
        webflow_sku_id: s.id,
        sku: sfd.sku ?? null,
        name: sfd.name ?? null,
        slug: sfd.slug ?? null,
        price: priceNum,
        currency: (sfd.price?.currency || sfd.price?.unit || "EUR") ?? "EUR",
        option_values: sfd["sku-values"] ?? null,
        main_image_url: sfd["main-image"]?.url ?? null,
        raw_field_data: sfd,
      };
    });

    if (variantRows.length) {
      const upVar = await sb
        .from("product_variants")
        .upsert(variantRows, { onConflict: "webflow_sku_id" });

      if (upVar.error) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upVar.error.message },
          { status: 500 }
        );
      }
    }

    return Response.json({
      ok: true,
      webflowProductId: product.id,
      productDbId: dbProductId,
      variants: variantRows.length,
      url: productRow.url,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "Internal error", details: String(e?.message || e) }, { status: 500 });
  }
}
