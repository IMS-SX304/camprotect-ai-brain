// app/ai/api/admin/sync-product/route.ts
import { supabaseAdmin } from "../../../../../lib/supabaseAdmin";

export const runtime = "nodejs";

type Body = {
  webflowProductId: string;
};

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizeBaseUrl(u: string) {
  // ex: https://www.camprotect.fr (sans slash final)
  return u.replace(/\/+$/, "");
}

function priceFromWebflow(value: unknown): number | null {
  // Webflow v2: price.value est souvent en centimes (int)
  if (typeof value !== "number") return null;
  return Math.round((value / 100) * 100) / 100; // 2 décimales
}

function isAdmin(req: Request) {
  const adminToken = requireEnv("ADMIN_TOKEN");
  const got = req.headers.get("x-admin-token") || "";
  return got === adminToken;
}

async function webflowGet(path: string) {
  const token = requireEnv("WEBFLOW_API_TOKEN");
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

export async function POST(req: Request) {
  try {
    if (!isAdmin(req)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const webflowProductId = (body.webflowProductId || "").trim();
    if (!webflowProductId) {
      return Response.json({ ok: false, error: "Missing webflowProductId" }, { status: 400 });
    }

    const baseUrl = normalizeBaseUrl(requireEnv("CAMPROTECT_BASE_URL")); // ex: https://www.camprotect.fr
    const supa = supabaseAdmin();

    // 1) Récupération Webflow (produit + skus)
    // Endpoint que tu utilises déjà : GET /v2/products/:id
    const wf = await webflowGet(`/products/${encodeURIComponent(webflowProductId)}`);

    const product = wf?.product;
    const skus: any[] = Array.isArray(wf?.skus) ? wf.skus : [];

    if (!product?.id) {
      return Response.json({ ok: false, error: "Webflow product not found in response" }, { status: 404 });
    }

    const fieldData = product.fieldData || {};
    const slug: string | undefined = fieldData.slug;
    const name: string | undefined = fieldData.name;

    const url = slug ? `${baseUrl}/product/${slug}` : null;

    // Champs “métier” (adapte si tu veux mapper plus)
    const brand =
      typeof fieldData.fabricants === "string"
        ? fieldData.fabricants
        : (typeof fieldData.brand === "string" ? fieldData.brand : null);

    const product_reference =
      typeof fieldData["product-reference"] === "string"
        ? fieldData["product-reference"]
        : (typeof fieldData["code-fabricant"] === "string" ? fieldData["code-fabricant"] : null);

    const product_type =
      typeof fieldData["type-de-produit"] === "string" ? fieldData["type-de-produit"] : null;

    const description =
      typeof fieldData.description === "string"
        ? fieldData.description
        : (typeof fieldData["description-mini"] === "string" ? fieldData["description-mini"] : null);

    // 2) Upsert product
    const productRow = {
      webflow_product_id: product.id as string,
      slug: slug ?? null,
      url,
      name: name ?? null,
      brand,
      product_reference,
      product_type,
      description,
      payload: fieldData, // on stocke tous les champs CMS ici (jsonb)
      updated_at: new Date().toISOString(),
    };

    const { data: upsertedProduct, error: upsertProdErr } = await supa
      .from("products")
      .upsert(productRow, { onConflict: "webflow_product_id" })
      .select("id, webflow_product_id")
      .single();

    if (upsertProdErr || !upsertedProduct) {
      return Response.json(
        { ok: false, error: "Supabase products upsert failed", details: upsertProdErr?.message || "no row" },
        { status: 500 }
      );
    }

    const productId = upsertedProduct.id as number;

    // 3) Upsert variants (SKUs)
    const variantsRows = skus.map((s: any) => {
      const fd = s?.fieldData || {};
      const priceValue = fd?.price?.value;
      const currency = fd?.price?.unit || "EUR";

      // option_values = mapping "sku-values" => ids de choix
      const optionValues = fd?.["sku-values"] || null;

      const mainImageUrl =
        typeof fd?.["main-image"]?.url === "string" ? fd["main-image"].url : null;

      // SKU “marchand” (celui que les clients cherchent)
      const sku = typeof fd?.sku === "string" ? fd.sku : null;

      return {
        product_id: productId,
        webflow_sku_id: s.id as string,
        sku,
        name: typeof fd?.name === "string" ? fd.name : null,
        slug: typeof fd?.slug === "string" ? fd.slug : null,
        price: priceFromWebflow(priceValue),
        currency: typeof currency === "string" ? currency : "EUR",
        option_values: optionValues, // JSONB
        is_default: (product?.fieldData?.["default-sku"] === s.id) || false,
        main_image_url: mainImageUrl,
        updated_at: new Date().toISOString(),
      };
    });

    if (variantsRows.length > 0) {
      const { error: upsertVarErr } = await supa
        .from("product_variants")
        .upsert(variantsRows, { onConflict: "webflow_sku_id" });

      if (upsertVarErr) {
        return Response.json(
          { ok: false, error: "Supabase variants upsert failed", details: upsertVarErr.message },
          { status: 500 }
        );
      }
    }

    return Response.json({
      ok: true,
      webflowProductId,
      supabaseProductId: productId,
      inserted_variants: variantsRows.length,
      url,
    });
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Internal error", details: e?.message || String(e) },
      { status: 500 }
    );
  }
}
