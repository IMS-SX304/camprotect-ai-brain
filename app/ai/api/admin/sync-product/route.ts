// app/ai/api/admin/sync-product/route.ts
import { getProduct, moneyToNumber } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function assertAdmin(req: Request) {
  const admin = process.env.ADMIN_TOKEN;
  const got = req.headers.get("x-admin-token");
  if (!admin || !got || got !== admin) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function productUrlFromSlug(slug: string | null | undefined) {
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

  const body = await req.json().catch(() => ({}));
  const webflowProductId = String(body?.webflowProductId || "");
  if (!webflowProductId) {
    return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
  }

  const sb = supabaseAdmin();

  try {
    const data = await getProduct(siteId, webflowProductId);
    const product = data?.product;
    const skus = Array.isArray(data?.skus) ? data.skus : [];

    const slug = product?.fieldData?.slug ?? null;
    const url = productUrlFromSlug(slug);

    const productRow = {
      webflow_product_id: product?.id ?? webflowProductId,
      slug,
      name: product?.fieldData?.name ?? null,
      brand: product?.fieldData?.fabricants ?? null,
      product_reference:
        product?.fieldData?.product_reference ??
        product?.fieldData?.["product-reference"] ??
        null,
      url,

      description: product?.fieldData?.description ?? null,
      meta_description: product?.fieldData?.["meta-description"] ?? null,
      bullet_point: product?.fieldData?.["bullet-point"] ?? null,
      description_complete: product?.fieldData?.["description-complete"] ?? null,
      texte_supplementaire_fiche_produit:
        product?.fieldData?.["texte-supplementaire-fiche-produit"] ?? null,
      fiche_technique_url: product?.fieldData?.["fiche-technique-du-produit"]?.url ?? null,
      altword: product?.fieldData?.altword ?? null,
    };

    const upProd = await sb
      .from("products")
      .upsert(productRow, { onConflict: "webflow_product_id" })
      .select("id")
      .single();

    if (upProd.error) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upProd.error.message },
        { status: 500 }
      );
    }

    const productId = upProd.data.id;

    const variantRows = skus.map((s: any) => {
      const money = s?.fieldData?.price || null;
      const price = moneyToNumber(money);

      return {
        product_id: productId,
        webflow_product_id: product?.id ?? webflowProductId,
        webflow_sku_id: s?.id ?? null,
        sku: s?.fieldData?.sku ?? null,
        name: s?.fieldData?.name ?? null,
        slug: s?.fieldData?.slug ?? null,
        price,
        price_raw: typeof money?.value === "number" ? money.value : null,
        currency: (money?.currency || money?.unit || "EUR") ?? "EUR",
        option_values: s?.fieldData?.["sku-values"] ?? null,
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

    return Response.json({ ok: true, synced: { productId: webflowProductId, variants: variantRows.length } });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: String(e?.message || e) },
      { status: 500 }
    );
  }
}
