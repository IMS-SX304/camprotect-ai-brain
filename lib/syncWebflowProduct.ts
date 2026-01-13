// lib/syncWebflowProduct.ts
import { webflowJson } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type WebflowPrice = { value: number; unit?: string };

type WebflowSku = {
  id: string;
  fieldData?: {
    sku?: string;
    name?: string;
    slug?: string;
    price?: WebflowPrice | null;
    "compare-at-price"?: WebflowPrice | null;
    "sku-values"?: Record<string, string>;
  };
};

type WebflowProduct = {
  id: string;
  fieldData?: {
    name?: string;
    slug?: string;
    description?: string;
    "description-mini"?: string;
    "description-complete"?: string;
    fabricants?: string;
    "product-reference"?: string;
    "code-fabricant"?: string;
    altword?: string;
    "benefice-court"?: string;
    "meta-description"?: string;
    "fiche-technique-du-produit"?: { url?: string } | null;
    "sku-properties"?: Array<{
      id: string;
      name: string;
      enum: Array<{ id: string; name: string; slug: string }>;
    }>;
    "default-sku"?: string;
    "type-de-produit"?: string;
  };
};

function toMoney(price?: WebflowPrice | null): number | null {
  if (!price || typeof price.value !== "number") return null;
  const v = price.value;
  // Webflow renvoie souvent en cents (>=1000 => 24354 = 243.54)
  if (v >= 1000) return Math.round(v) / 100;
  return v;
}

function camprotectUrlFromSlug(slug?: string | null): string | null {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  if (!slug) return null;
  return `${base}/product/${slug}`;
}

/**
 * ✅ EXPORT IMPORTANT
 */
export async function syncWebflowProduct(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  // GET product + skus
  const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

  const product: WebflowProduct | undefined = data?.product;
  const skus: WebflowSku[] = Array.isArray(data?.skus) ? data.skus : [];

  if (!product?.id) throw new Error("Webflow product payload missing product.id");

  const pfd = product.fieldData || {};
  const slug = (pfd.slug || "").trim();
  const url = camprotectUrlFromSlug(slug);

  // Default SKU -> référence principale
  const defaultSkuId = pfd["default-sku"];
  const defaultSku = skus.find((s) => s.id === defaultSkuId) || skus[0];

  const skuCode =
    (defaultSku?.fieldData?.sku ||
      pfd["product-reference"] ||
      pfd["code-fabricant"] ||
      "").trim() || null;

  // Prix "à partir de" = min des variantes
  const prices = skus
    .map((s) => toMoney(s.fieldData?.price ?? null))
    .filter((x): x is number => typeof x === "number");
  const minPrice = prices.length ? Math.min(...prices) : null;

  // fiche technique (champ upload Webflow)
  const ficheTechUrl = (pfd["fiche-technique-du-produit"] as any)?.url || null;

  const supa = supabaseAdmin();

  // UPSERT product
  const productRow: any = {
    webflow_product_id: product.id,
    slug: slug || null,
    url: url,
    name: (pfd.name || "").trim() || null,
    product_type: (pfd["type-de-produit"] || "").trim() || null,

    sku: skuCode,
    price: minPrice,
    currency: "EUR",

    altword: (pfd.altword || "").trim() || null,
    benefice_court: (pfd["benefice-court"] || "").trim() || null,
    meta_description: (pfd["meta-description"] || "").trim() || null,
    fiche_technique_url: ficheTechUrl,

    payload: { ...pfd, camprotect_url: url },
    updated_at: new Date().toISOString(),
  };

  const { data: upProd, error: upProdErr } = await supa
    .from("products")
    .upsert(productRow, { onConflict: "webflow_product_id" })
    .select("id")
    .single();

  if (upProdErr) throw new Error(`Supabase products upsert failed: ${upProdErr.message}`);

  const productId = upProd?.id;
  if (!productId) throw new Error("Supabase products upsert did not return id");

  // UPSERT variants
  const variantRows = skus.map((s) => {
    const sfd = s.fieldData || {};
    return {
      webflow_sku_id: s.id,
      webflow_product_id: product.id,
      product_id: productId,

      sku: (sfd.sku || "").trim() || null,
      title: (sfd.name || "").trim() || null,
      slug: (sfd.slug || "").trim() || null,
      price: toMoney(sfd.price ?? null),
      currency: (sfd.price?.unit || "EUR").toString(),

      option_values: sfd["sku-values"] || null,
      payload: sfd,
      updated_at: new Date().toISOString(),
    };
  });

  if (variantRows.length) {
    const { error: upVarErr } = await supa
      .from("product_variants")
      .upsert(variantRows, { onConflict: "webflow_sku_id" });

    if (upVarErr) throw new Error(`Supabase variants upsert failed: ${upVarErr.message}`);
  }

  return { ok: true, productId, variants: variantRows.length };
}
