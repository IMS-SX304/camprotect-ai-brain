// lib/syncWebflowProduct.ts
import { webflowJson, moneyToNumber } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function productUrlFromSlug(slug?: string | null) {
  const base = (process.env.CAMPROTECT_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !slug) return null;
  return `${base}/product/${slug}`;
}

export async function syncWebflowProduct(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  const sb = supabaseAdmin();

  // 1) Récupérer produit + skus (variantes)
  const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });
  const product = data?.product;
  const skus = data?.skus || [];

  if (!product?.id) throw new Error("Product not found in Webflow response");

  const fd = product.fieldData || {};
  const slug = fd.slug ?? null;

  // 2) Upsert product
  const productRow: any = {
    webflow_product_id: product.id,
    slug,
    name: fd.name ?? null,
    brand: fd.fabricants ?? fd.brand ?? null,
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

  if (upProd.error) throw new Error(`Supabase products upsert failed: ${upProd.error.message}`);

  const dbProductId = upProd.data.id;

  // 3) Upsert variants
  const variantRows = (skus as any[]).map((s) => {
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

    if (upVar.error) throw new Error(`Supabase variants upsert failed: ${upVar.error.message}`);
  }

  return {
    webflowProductId: product.id,
    productDbId: dbProductId,
    variants: variantRows.length,
    url: productRow.url,
  };
}
