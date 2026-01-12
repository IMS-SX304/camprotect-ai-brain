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
    "sku-values"?: Record<string, string>; // optionId -> enumId
  };
};

type WebflowProduct = {
  id: string;
  fieldData?: {
    name?: string;
    slug?: string;
    description?: string;

    // champs CMS (exemples)
    altword?: string;
    "benefice-court"?: string;
    "meta-description"?: string;

    // ⚠️ suivant ton CMS, ce champ peut être différent
    // on va l'extraire de façon robuste via payload
    "fiche-technique-du-produit"?: any;

    "product-reference"?: string;
    "code-fabricant"?: string;

    "default-sku"?: string;
  };
};

function toMoney(price?: WebflowPrice | null): number | null {
  if (!price || typeof price.value !== "number") return null;
  const v = price.value;
  if (v >= 1000) return Math.round(v) / 100;
  return v;
}

function camprotectUrlFromSlug(slug?: string | null): string | null {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  if (!slug) return null;
  return `${base}/product/${slug}`;
}

// Extraction robuste de l'URL depuis un champ Webflow (string | {url} | [{url}] | {href})
function extractUrl(value: any): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const s = value.trim();
    return s ? s : null;
  }

  // tableau: prend le premier
  if (Array.isArray(value)) {
    const first = value[0];
    return extractUrl(first);
  }

  // objet
  if (typeof value === "object") {
    if (typeof value.url === "string" && value.url.trim()) return value.url.trim();
    if (typeof value.href === "string" && value.href.trim()) return value.href.trim();
  }

  return null;
}

export async function syncWebflowProduct(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  // 1) Récupération produit + skus
  const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

  const product: WebflowProduct | undefined = data?.product;
  const skus: WebflowSku[] = Array.isArray(data?.skus) ? data.skus : [];

  if (!product?.id) throw new Error("Webflow product payload missing product.id");

  const pfd = product.fieldData || {};
  const slug = (pfd.slug || "").trim();
  const url = camprotectUrlFromSlug(slug);

  // SKU principal
  const defaultSkuId = pfd["default-sku"];
  const defaultSku = skus.find((s) => s.id === defaultSkuId) || skus[0];

  const skuCode =
    (defaultSku?.fieldData?.sku ||
      pfd["product-reference"] ||
      pfd["code-fabricant"] ||
      "").trim() || null;

  // Prix min des variantes
  const prices = skus
    .map((s) => toMoney(s.fieldData?.price ?? null))
    .filter((x): x is number => typeof x === "number");
  const minPrice = prices.length ? Math.min(...prices) : null;

  // ✅ FICHE TECHNIQUE (robuste)
  // IMPORTANT: suivant ton Webflow, la donnée peut aussi être dans data.product.fieldData["fiche-technique-du-produit"]
  const ftAny =
    (pfd as any)["fiche-technique-du-produit"] ??
    (pfd as any)["fiche-technique"] ??
    (pfd as any)["datasheet"] ??
    null;

  const ficheTechUrl = extractUrl(ftAny);

  const supa = supabaseAdmin();

  // 2) UPSERT product
  const productRow: any = {
    webflow_product_id: product.id,
    slug: slug || null,
    url: url || null,

    name: (pfd.name || "").trim() || null,
    description: (pfd.description || "").trim() || null,

    sku: skuCode,
    price: minPrice,
    currency: "EUR",

    altword: (pfd.altword || "").trim() || null,
    benefice_court: (pfd["benefice-court"] || "").trim() || null,
    meta_description: (pfd["meta-description"] || "").trim() || null,

    // ✅ colonne déjà présente chez toi
    fiche_technique_url: ficheTechUrl,

    // JSON brut
    payload: {
      ...pfd,
      camprotect_url: url,
      fiche_technique_url: ficheTechUrl, // pratique pour debug
    },

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

  // 3) UPSERT variants
  const variantRows = skus.map((s) => {
    const sfd = s.fieldData || {};
    return {
      webflow_sku_id: s.id,
      webflow_product_id: product.id,
      product_id: productId,

      sku: (sfd.sku || "").trim() || null,
      name: (sfd.name || "").trim() || null,
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

  return { ok: true, productId, variants: variantRows.length, ficheTechUrl };
}
