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
  if (!expected || token !== expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const authFail = requireAdmin(req);
    if (authFail) return authFail;

    const body = (await req.json()) as Body;
    const webflowProductId = (body.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const siteId = process.env.WEBFLOW_SITE_ID;
    if (!siteId) {
      return Response.json({ ok: false, error: "Missing WEBFLOW_SITE_ID" }, { status: 500 });
    }

    const baseUrl = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr/product/").trim();

    // ✅ Webflow v2 eCommerce: Get Product (inclut skus)
    // Doc: /v2/sites/:site_id/products/:product_id
    const wf = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

    // Format attendu (comme ton JSON) : { product: {...}, skus: [...] }
    const product = wf?.product;
    const skus = Array.isArray(wf?.skus) ? wf.skus : [];

    if (!product?.id) {
      return Response.json({ ok: false, error: "Webflow product not found / invalid payload" }, { status: 404 });
    }

    const slug: string | null = product?.fieldData?.slug || null;
    const name: string | null = product?.fieldData?.name || null;

    const productUrl = slug ? `${baseUrl.replace(/\/?$/, "/")}${slug}` : null;

    // On prend le "default-sku" si présent, sinon le 1er sku
    const defaultSkuId: string | null = product?.fieldData?.["default-sku"] || null;
    const defaultSku = (defaultSkuId && skus.find((s: any) => s?.id === defaultSkuId)) || skus[0] || null;

    // SKU code (référence vendue) + prix de base
    const skuCode: string | null = defaultSku?.fieldData?.sku || null;
    const money = defaultSku?.fieldData?.price || null;
    const currency = (money?.currency || money?.unit || "EUR") as string;
    const price = moneyToNumber(money);

    // Champs utiles CMS/SEO (si présents côté product.fieldData)
    const brand = product?.fieldData?.fabricants || product?.fieldData?.brand || null;
    const product_reference = product?.fieldData?.["product-reference"] || product?.fieldData?.["code-fabricant"] || null;

    const supa = supabaseAdmin();

    // 1) Upsert product
    const { data: upP, error: upPErr } = await supa
      .from("products")
      .upsert(
        {
          webflow_product_id: product.id,
          slug,
          url: productUrl,
          name,
          brand,
          product_reference,
          sku: skuCode,
          price,
          currency,
          payload: product?.fieldData || {},
        },
        { onConflict: "webflow_product_id" }
      )
      .select("id")
      .maybeSingle();

    if (upPErr) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upPErr.message },
        { status: 500 }
      );
    }

    const productRowId = upP?.id;

    // 2) Upsert variants (skus)
    let variantsUpserted = 0;

    if (productRowId && skus.length) {
      const rows = skus.map((s: any) => {
        const m = s?.fieldData?.price || null;
        const vPrice = moneyToNumber(m);
        const vCurrency = (m?.currency || m?.unit || currency || "EUR") as string;

        // sku-values = mapping optionId -> enumId (chez Webflow)
        const optionValues = s?.fieldData?.["sku-values"] || s?.["sku-values"] || s?.fieldData?.skuValues || null;

        return {
          product_id: productRowId,
          webflow_sku_id: s?.id,
          sku: s?.fieldData?.sku || null,
          name: s?.fieldData?.name || null,
          slug: s?.fieldData?.slug || null,
          price: vPrice,
          currency: vCurrency,
          option_values: optionValues || {},
          payload: s?.fieldData || {},
        };
      });

      const { error: upVErr, data: upV } = await supa
        .from("product_variants")
        .upsert(rows, { onConflict: "webflow_sku_id" })
        .select("id");

      if (upVErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upVErr.message },
          { status: 500 }
        );
      }

      variantsUpserted = Array.isArray(upV) ? upV.length : 0;
    }

    return Response.json({
      ok: true,
      product: {
        webflow_product_id: product.id,
        name,
        slug,
        url: productUrl,
        sku: skuCode,
        price,
        currency,
      },
      variantsUpserted,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
