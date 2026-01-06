// app/ai/api/admin/sync-product/route.ts
import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { getWebflowProductWithSkus, webflowMoneyToNumber, buildCamprotectProductUrl } from "../../../../../lib/webflow";

export const runtime = "nodejs";

type Body = {
  webflowProductId: string; // ex: "6915ba34c737dbb25b00bb96"
};

function requireAdminToken(req: Request) {
  const got = req.headers.get("x-admin-token") || "";
  const expected = process.env.ADMIN_TOKEN || "";
  if (!expected || got !== expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const auth = requireAdminToken(req);
  if (auth) return auth;

  try {
    const body = (await req.json()) as Body;
    const webflowProductId = (body.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    // 1) Fetch produit + SKUs (variantes) depuis Webflow (endpoint site-scoped)
    const wf = await getWebflowProductWithSkus(webflowProductId);

    const product = wf.product;
    const productSlug = product.fieldData?.slug || null;
    const productName = product.fieldData?.name || null;

    const productUrl = buildCamprotectProductUrl(productSlug);

    // 2) Upsert produit (table "products")
    const supa = supabaseAdmin();

    const { data: upsertedProduct, error: upsertErr } = await supa
      .from("products")
      .upsert(
        {
          webflow_product_id: webflowProductId,
          slug: productSlug,
          name: productName,
          url: productUrl,
          // tu peux aussi mapper brand / product_reference etc si tu les as dans fieldData
          payload: product.fieldData ?? {},
        },
        { onConflict: "webflow_product_id" }
      )
      .select("id, webflow_product_id, slug, url")
      .maybeSingle();

    if (upsertErr) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upsertErr.message },
        { status: 500 }
      );
    }
    if (!upsertedProduct) {
      return Response.json({ ok: false, error: "Product upsert returned null" }, { status: 500 });
    }

    // 3) Upsert variantes (table "product_variants")
    // On suppose que tu as une table product_variants existante (tu as déjà confirmé qu’elle existe)
    // Champs minimum conseillés: webflow_sku_id (unique), webflow_product_id, sku, name, slug, price, currency, url, option_values(jsonb), payload(jsonb)
    let insertedVariants = 0;

    for (const s of wf.skus || []) {
      const skuId = s.id;
      const sku = s.fieldData?.sku || null;
      const name = s.fieldData?.name || null;
      const slug = s.fieldData?.slug || null;
      const priceNum = webflowMoneyToNumber(s.fieldData?.price ?? null);
      const currency = s.fieldData?.price?.unit || "EUR";

      // URL "produit" (pas forcément URL SKU). On garde l’URL produit principale.
      const url = productUrl;

      const optionValues = s.fieldData?.["sku-values"] ?? null;

      const { error: vErr } = await supa
        .from("product_variants")
        .upsert(
          {
            webflow_sku_id: skuId,
            webflow_product_id: webflowProductId,
            sku,
            name,
            slug,
            price: priceNum,
            currency,
            url,
            option_values: optionValues,
            payload: s.fieldData ?? {},
          },
          { onConflict: "webflow_sku_id" }
        );

      if (vErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: vErr.message },
          { status: 500 }
        );
      }
      insertedVariants += 1;
    }

    return Response.json({
      ok: true,
      webflowProductId,
      product: {
        slug: productSlug,
        url: productUrl,
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
