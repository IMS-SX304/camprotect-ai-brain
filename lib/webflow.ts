// lib/webflow.ts

const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function buildProductUrl(slug: string) {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  return `${base}/product/${slug}`;
}

async function webflowFetch(path: string) {
  const token = mustEnv("WEBFLOW_API_TOKEN");
  const res = await fetch(`${WEBFLOW_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    // Important en runtime nodejs
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webflow ${res.status}: ${text}`);
  return JSON.parse(text);
}

/**
 * Convertit un objet Webflow price { value: 24354, unit: "EUR" }
 * en centimes (int). Si nul, retourne null.
 */
export function priceToCents(price: any): number | null {
  if (!price) return null;
  const v = price.value;
  if (typeof v === "number") return Math.trunc(v); // Webflow est déjà en "centimes" dans ton JSON
  if (typeof v === "string" && v.trim() !== "") return Math.trunc(Number(v));
  return null;
}

/**
 * GET product + skus: /v2/products/:id
 * Retour attendu : { product: {...}, skus: [...] }
 */
export async function getWebflowProductWithSkus(productId: string): Promise<{
  product: any;
  skus: any[];
}> {
  const data = await webflowFetch(`/products/${productId}`);
  // Webflow renvoie bien { product, skus }
  if (!data?.product) throw new Error("Webflow response missing 'product'");
  return { product: data.product, skus: Array.isArray(data.skus) ? data.skus : [] };
}
