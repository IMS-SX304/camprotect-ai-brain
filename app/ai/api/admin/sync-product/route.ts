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
  fieldData?: Record<string, any>;
};

function toMoney(price?: WebflowPrice | null): number | null {
  if (!price || typeof price.value !== "number") return null;
  const v = price.value;
  if (v >= 1000) return Math.round(v) / 100; // cents -> euros
  return v;
}

function camprotectUrlFromSlug(slug?: string | null): string | null {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  if (!slug) return null;
  return `${base}/product/${slug}`;
}

type OptionMapRow = {
  field_slug: string;
  option_id: string;
  option_name: string;
};

async function loadOptionMap() {
  const supa = supabaseAdmin();
  const { data, error } = await supa
    .from("webflow_option_map")
    .select("field_slug,option_id,option_name");

  if (error) throw new Error(`Supabase option_map read failed: ${error.message}`);

  const map = new Map<string, Map<string, string>>();
  for (const r of (data || []) as OptionMapRow[]) {
    if (!r.field_slug || !r.option_id) continue;
    if (!map.has(r.field_slug)) map.set(r.field_slug, new Map());
    map.get(r.field_slug)!.set(r.option_id, r.option_name);
  }
  return map;
}

function mapOptionValue(optionMap: Map<string, Map<string, string>>, fieldSlug: string, v: any) {
  if (!v) return null;

  // Webflow "Option" = généralement 1 id string
  if (typeof v === "string") {
    return optionMap.get(fieldSlug)?.get(v) ?? null;
  }

  // Parfois ça peut être array (selon config), on gère au cas où
  if (Array.isArray(v)) {
    const names = v
      .map((id) => (typeof id === "string" ? optionMap.get(fieldSlug)?.get(id) : null))
      .filter(Boolean) as string[];
    return names.length ? names : null;
  }

  return null;
}

export async function syncWebflowProduct(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  const supa = supabaseAdmin();
  const optionMap = await loadOptionMap();

  // 1) Récupération produit + variantes (skus)
  const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

  const product: WebflowProduct | undefined = data?.product;
  const skus: WebflowSku[] = Array.isArray(data?.skus) ? data.skus : [];

  if (!product?.id) throw new Error("Webflow product payload missing product.id");

  const pfd = (product.fieldData || {}) as Record<string, any>;

  const slug = (pfd.slug || "").toString().trim();
  const url = camprotectUrlFromSlug(slug);

  // SKU principal : default-sku si dispo, sinon 1er sku
  const defaultSkuId = pfd["default-sku"];
  const defaultSku = skus.find((s) => s.id === defaultSkuId) || skus[0];

  const skuCode =
    (defaultSku?.fieldData?.sku ||
      pfd["product-reference"] ||
      pfd["code-fabricant"] ||
      pfd["product_reference"] ||
      "").toString().trim() || null;

  // Prix min variantes (si produit sans prix direct)
  const prices = skus
    .map((s) => toMoney(s.fieldData?.price ?? null))
    .filter((x): x is number => typeof x === "number");
  const minPrice = prices.length ? Math.min(...prices) : null;

  // ✅ Traduction des champs Option (IDs -> noms)
  // Liste issue de ton retour "fields"
  const optionFields = [
    "ec-product-type",
    "fabricants",
    "couleur",
    "micro-integre-2",
    "nombre-de-canaux---filtre",
    "type-enregistreur",
    "stockage---filtre",
    "environnement",
    "nombre-de-port",
    "nombre-de-port-hi-poe",
    "nombre-de-port-sfp",
  ] as const;

  const readableOptions: Record<string, any> = {};
  for (const f of optionFields) {
    const mapped = mapOptionValue(optionMap, f, pfd[f]);
    if (mapped) readableOptions[f] = mapped;
  }

  // Brand lisible = fabricants si présent
  const brandText =
    (typeof readableOptions["fabricants"] === "string" ? readableOptions["fabricants"] : null) ||
    null;

  // Fiche technique url (si upload)
  const ficheUrl =
    (pfd["fiche-technique-du-produit"]?.url ||
      pfd["fiche_technique_du_produit"]?.url ||
      pfd["fiche_technique_url"] ||
      pfd["fiche-technique-url"] ||
      null) ?? null;

  // 2) UPSERT product
  const productRow: any = {
    webflow_product_id: product.id,
    slug: slug || null,
    url: url,
    name: (pfd.name || "").toString().trim() || null,
    description: (pfd.description || pfd["description-complete"] || "").toString().trim() || null,

    // clés business
    sku: skuCode,
    price: minPrice,
    currency: "EUR",

    // ✅ champs lisibles (plus d'IDs)
    brand: brandText,
    fiche_technique_url: ficheUrl,

    // champs SEO / utiles IA
    altword: (pfd.altword || "").toString().trim() || null,
    benefice_court: (pfd["benefice-court"] || "").toString().trim() || null,
    meta_description: (pfd["meta-description"] || "").toString().trim() || null,

    // Payload complet + options traduites
    payload: {
      ...pfd,
      camprotect_url: url,
      options_readable: readableOptions, // <= super important pour l’IA
    },
    updated_at: new Date().toISOString(),
  };

  const { data: upProd, error: upProdErr } = await supa
    .from("products")
    .upsert(productRow, { onConflict: "webflow_product_id" })
    .select("id")
    .single();

  if (upProdErr) {
    throw new Error(`Supabase products upsert failed: ${upProdErr.message}`);
  }

  const productId = upProd?.id;
  if (!productId) throw new Error("Supabase products upsert did not return id");

  // 3) UPSERT variants
  const variantRows = skus.map((s) => {
    const sfd = s.fieldData || {};
    return {
      webflow_sku_id: s.id,
      webflow_product_id: product.id,
      product_id: productId,
      sku: (sfd.sku || "").toString().trim() || null,
      name: (sfd.name || "").toString().trim() || null,
      slug: (sfd.slug || "").toString().trim() || null,
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

    if (upVarErr) {
      throw new Error(`Supabase variants upsert failed: ${upVarErr.message}`);
    }
  }

  return { ok: true, productId, variants: variantRows.length };
}
