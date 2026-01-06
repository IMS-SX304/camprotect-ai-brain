// lib/webflow.ts

type WebflowPrice = { value: number; unit: string };
type WebflowSku = {
  id: string;
  fieldData?: {
    price?: WebflowPrice | null;
    sku?: string | null;
    name?: string | null;
    slug?: string | null;
    "sku-values"?: Record<string, string> | null;
  };
};

type WebflowProduct = {
  id: string;
  fieldData?: {
    slug?: string | null;
    name?: string | null;
  };
};

type WebflowGetProductResponse = {
  product: WebflowProduct;
  skus: WebflowSku[];
};

async function webflowFetch(path: string) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  const res = await fetch(`https://api.webflow.com${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * Récupère un produit e-commerce + ses SKUs (variantes) via Data API v2
 * Endpoint: /v2/sites/:site_id/products/:product_id
 */
export async function getWebflowProductWithSkus(productId: string): Promise<WebflowGetProductResponse> {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  // ✅ Endpoint correct (site-scoped)
  return webflowFetch(`/v2/sites/${siteId}/products/${productId}`);
}

/** Webflow renvoie le prix en centimes: 24354 -> 243.54 */
export function webflowMoneyToNumber(price?: WebflowPrice | null): number | null {
  if (!price || typeof price.value !== "number") return null;
  return price.value / 100;
}

export function buildCamprotectProductUrl(slug?: string | null): string | null {
  if (!slug) return null;
  const base = process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr";
  return `${base.replace(/\/$/, "")}/product/${slug}`;
}
