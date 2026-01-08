// lib/syncWebflowProduct.ts
import { webflowJson } from "@/lib/webflow";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type SyncResult = {
  productUpserted: boolean;
  variantsUpserted: number;
  webflowProductId: string;
  slug?: string;
  url?: string;
};

type WebflowPrice = { value: number; unit: string };

type WebflowSku = {
  id: string;
  fieldData?: {
    name?: string;
    slug?: string;
    sku?: string;
    price?: WebflowPrice | null;
    compareAtPrice?: WebflowPrice | null;
    // Attention aux clés avec tirets : on les accède via ["..."]
    ["compare-at-price"]?: WebflowPrice | null;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    ["sku-values"]?: Record<string, string>;
    // (TS aime pas les clés avec tiret si tu les déclares pas — on reste permissif)
    [key: string]: any;
  };
};

type WebflowProductResponse = {
  product?: {
    id: string;
    fieldData?: Record<string, any>;
  };
  skus?: WebflowSku[];
};

function priceToNumber(p?: WebflowPrice | null): number | null {
  if (!p || typeof p.value !== "number") return null;
  // Webflow renvoie souvent en centimes => 24354 = 243.54
  return p.value / 100;
}

function buildProductUrl(slug?: string): string | null {
  if (!slug) return null;
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/+$/, "");
  // Tu m’as confirmé le pattern /product/slug
  return `${base}/product/${slug}`;
}

export async function syncWebflowProduct(webflowProductId: string): Promise<SyncResult> {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  // 1) Fetch produit + variantes depuis Webflow (V2)
  const data = (await webflowJson(
    `/sites/${siteId}/products/${webflowProductId}`,
    { method: "GET" }
  )) as WebflowProductResponse;

  const product = data?.product;
  if (!product?.id) throw new Error("Webflow product not found / invalid response");

  const fd = product.fieldData || {};
  const name: string | null = fd.name ?? null;
  const slug: string | null = fd.slug ?? null;
  const url = buildProductUrl(slug || undefined);

  // 2) Upsert product (⚠️ pas de colonne title)
  const supa = supabaseAdmin();

  // Adapte ici UNIQUEMENT aux colonnes qui existent chez toi.
  // On envoie: webflow_product_id, name, slug, url, payload
  const productRow: any = {
    webflow_product_id: product.id,
    name,
    slug,
    url,
    payload: fd, // on garde tout pour l’IA
  };

  const upProd = await supa
    .from("products")
    .upsert(productRow, { onConflict: "webflow_product_id" });

  if (upProd.error) {
    throw new Error(`Supabase products upsert failed: ${upProd.error.message}`);
  }

  // 3) Upsert variants
  const skus = Array.isArray(data?.skus) ? data.skus : [];
  let variantsUpserted = 0;

  if (skus.length > 0) {
    for (const sku of skus) {
      const sfd = sku.fieldData || {};
      const variantSku: string | null = sfd.sku ?? null;
      const variantName: string | null = sfd.name ?? null;
      const variantSlug: string | null = sfd.slug ?? null;

      // prix / compare-at-price : parfois key en camelCase, parfois en kebab-case
      const price = priceToNumber(sfd.price ?? null);
      const compareAt = priceToNumber(sfd["compare-at-price"] ?? sfd.compareAtPrice ?? null);

      const optionValues = sfd["sku-values"] ?? null; // mapping optionId -> enumId

      const variantRow: any = {
        webflow_sku_id: sku.id,
        webflow_product_id: product.id,
        sku: variantSku,
        name: variantName,
        slug: variantSlug,
        price,
        compare_at_price: compareAt,
        option_values: optionValues,
        payload: sfd,
      };

      const upVar = await supa
        .from("product_variants")
        .upsert(variantRow, { onConflict: "webflow_sku_id" });

      if (upVar.error) {
        throw new Error(`Supabase variants upsert failed: ${upVar.error.message}`);
      }

      variantsUpserted++;
    }
  }

  return {
    productUpserted: true,
    variantsUpserted,
    webflowProductId: product.id,
    slug: slug || undefined,
    url: url || undefined,
  };
}
