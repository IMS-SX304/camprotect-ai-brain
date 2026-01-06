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
    return false;
  }
  return true;
}

function baseUrl() {
  const b = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/+$/, "");
  return b;
}

function productUrlFromSlug(slug?: string | null) {
  if (!slug) return null;
  // Ta structure finale : https://www.camprotect.fr/product/<slug>
  return `${baseUrl()}/product/${slug}`;
}

function safeText(v: any): string | null {
  if (typeof v === "string") return v;
  return null;
}

function safeJson(v: any) {
  if (v && typeof v === "object") return v;
  return {};
}

export async function POST(req: Request) {
  try {
    if (!requireAdmin(req)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const webflowProductId = (body?.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const supa = supabaseAdmin();

    /**
     * Webflow v2:
     * Tu as confirmé que l’endpoint “Get product” te renvoie:
     * { product: {...}, skus: [...] }
     *
     * IMPORTANT:
     * Le chemin exact dépend de ton wrapper webflowJson.
     * Ici on appelle "products/<id>" (sans /v2), car webflowJson ajoute déjà /v2.
     */
    const wf = await webflowJson(`products/${webflowProductId}`, { method: "GET" });

    const product = wf?.product;
    const skus = Array.isArray(wf?.skus) ? wf.skus : [];

    if (!product?.id || !product?.fieldData) {
      return Response.json(
        { ok: false, error: "Webflow product payload unexpected", details: wf },
        { status: 500 }
      );
    }

    const fd = product.fieldData;

    // Champs utiles (adaptés à ton JSON)
    const slug = safeText(fd.slug);
    const name = safeText(fd.name) || "Produit";
    const brand = safeText(fd.fabricants) || safeText(fd.brand); // parfois c’est un ID de collection (ok on le stocke tel quel)
    const productReference = safeText(fd["product-reference"]) || safeText(fd["code-fabricant"]);
    const description = safeText(fd.description) || safeText(fd["description-mini"]);
    const metaDescription = safeText(fd["meta-description"]);
    const beneficeCourt = safeText(fd["benefice-court"]);
    const altword = safeText(fd.altword);

    const url = productUrlFromSlug(slug);

    // On stocke un payload JSONB riche (tout ce que tu veux réutiliser côté IA)
    const payload = {
      webflow: {
        productId: product.id,
        cmsLocaleId: product.cmsLocaleId,
        updated: product.lastUpdated,
        published: product.lastPublished,
      },
      fieldData: fd,
    };

    /**
     * 1) UPSERT produit
     * On veut récupérer products.id (bigint) pour le mettre dans product_variants.product_id
     */
    const { data: upsertedProduct, error: upsertProdErr } = await supa
      .from("products")
      .upsert(
        {
          webflow_product_id: product.id,
          slug,
          name,
          brand,
          product_reference: productReference,
          url,
          description,
          meta_description: metaDescription,
          benefice_court: beneficeCourt,
          altword,
          payload,
        },
        { onConflict: "webflow_product_id" }
      )
      .select("id, webflow_product_id, slug, url")
      .single();

    if (upsertProdErr || !upsertedProduct?.id) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upsertProdErr?.message || "unknown" },
        { status: 500 }
      );
    }

    const productDbId = upsertedProduct.id as number;

    /**
     * 2) UPSERT variants (skus)
     * IMPORTANT:
     * - product_variants.product_id = products.id (bigint) => NOT NULL
     * - webflow_sku_id unique conseillé (onConflict)
     */
    let insertedVariants = 0;

    for (const sku of skus) {
      const skuId = sku?.id;
      const skuFd = sku?.fieldData || {};

      if (!skuId) continue;

      // Webflow price en "minor units" => moneyToNumber() => 243.54
      const unitPrice = moneyToNumber(skuFd.price) ?? null;
      const currency = (skuFd.price?.unit || skuFd.price?.currency || "EUR") as string;

      // Option values / taille / etc (ex: { "propId": "enumId" })
      const optionValues = safeJson(skuFd["sku-values"]);

      const variantRow = {
        product_id: productDbId, // ✅ la correction clé
        webflow_sku_id: String(skuId),
        sku: safeText(skuFd.sku) || null,
        name: safeText(skuFd.name) || null,
        slug: safeText(skuFd.slug) || null,
        price: unitPrice, // numeric
        currency,
        option_values: optionValues, // jsonb
        payload: {
          webflow: { skuId: skuId, productId: product.id },
          fieldData: skuFd,
        },
      };

      const { error: upsertVarErr } = await supa
        .from("product_variants")
        .upsert(variantRow, { onConflict: "webflow_sku_id" });

      if (upsertVarErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upsertVarErr.message },
          { status: 500 }
        );
      }

      insertedVariants += 1;
    }

    return Response.json({
      ok: true,
      webflowProductId,
      product: {
        id: productDbId,
        slug: upsertedProduct.slug,
        url: upsertedProduct.url,
      },
      inserted_variants: insertedVariants,
    });
  } catch (e: any) {
    // Si Webflow renvoie 404 route not found, ça remontera ici aussi
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
