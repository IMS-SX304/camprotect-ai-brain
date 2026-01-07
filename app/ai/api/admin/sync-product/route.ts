// app/ai/api/admin/sync-products/route.ts

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
  const base = (process.env.CAMPROTECT_BASE_URL || "").replace(/\/$/, "");
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

  const sb = supabaseAdmin();

  const limit = 250;
  let offset = 0;
  let productsUpserted = 0;
  let variantsUpserted = 0;

  try {
    while (true) {
      const list = await webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`);
      const items = Array.isArray(list?.items) ? list.items : [];
      if (items.length === 0) break;

      for (const it of items) {
        const productId = it?.product?.id;
        if (!productId) continue;

        const detail = await webflowJson(`/sites/${siteId}/products/${productId}`);
        const product = detail?.product;
        const skus = Array.isArray(detail?.skus) ? detail.skus : [];
        const fd = product?.fieldData || {};
        const slug = fd?.slug ?? product?.slug ?? null;

        const productRow = {
          webflow_product_id: product?.id ?? productId,
          slug,
          name: fd?.name ?? null,
          brand: fd?.fabricants ?? fd?.brand ?? null,
          product_type: fd?.["type-de-produit"] ?? fd?.product_type ?? null,
          product_reference: fd?.["product-reference"] ?? fd?.product_reference ?? null,
          altword: fd?.altword ?? null,
          benefice_court: fd?.["benefice-court"] ?? null,
          meta_description: fd?.["meta-description"] ?? null,
          description: fd?.description ?? null,
          description_complete: fd?.["description-complete"] ?? null,
          fiche_technique_url: fd?.["fiche-technique-du-produit"]?.url ?? null,
          url: productUrlFromSlug(slug),
          last_published: product?.lastPublished ?? null,
          last_updated: product?.lastUpdated ?? null,
        };

        const upProd = await sb.from("products").upsert(productRow, {
          onConflict: "webflow_product_id",
        });

        if (upProd.error) {
          return Response.json(
            { ok: false, error: "Supabase products upsert failed", details: upProd.error.message },
            { status: 500 }
          );
        }
        productsUpserted += 1;

        for (const s of skus) {
          const sfd = s?.fieldData || {};
          const skuId = s?.id ?? null;
          if (!skuId) continue;

          const vRow = {
            webflow_product_id: product?.id ?? productId,
            webflow_sku_id: skuId,
            sku: sfd?.sku ?? null,
            name: sfd?.name ?? null,
            slug: sfd?.slug ?? null,
            url: productUrlFromSlug(slug), // URL page produit
            price: moneyToNumber(sfd?.price) ?? null,
            currency: (sfd?.price?.unit || sfd?.price?.currency || null) as string | null,
            option_values: sfd?.["sku-values"] ?? null,
            main_image_url: sfd?.["main-image"]?.url ?? null,
            updated_at: new Date().toISOString(),
          };

          const upVar = await sb.from("product_variants").upsert(vRow, {
            onConflict: "webflow_sku_id",
          });

          if (upVar.error) {
            return Response.json(
              { ok: false, error: "Supabase variants upsert failed", details: upVar.error.message },
              { status: 500 }
            );
          }
          variantsUpserted += 1;
        }
      }

      offset += limit;
    }

    return Response.json({
      ok: true,
      productsUpserted,
      variantsUpserted,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: String(e?.message || e) },
      { status: 500 }
    );
  }
}
