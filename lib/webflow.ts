// lib/webflow.ts

export type WebflowMoney = {
  value: number;       // souvent "minor units" (centimes)
  unit?: string;       // "EUR"
  currency?: string;   // parfois présent
};

export function moneyToNumber(m: WebflowMoney | null | undefined): number | null {
  if (!m || typeof m.value !== "number") return null;

  const c = String(m.currency || m.unit || "EUR").toUpperCase();
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

type WebflowErrorShape = { message?: string; msg?: string; code?: string };

export async function webflowJson(path: string, init?: RequestInit) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  const url = `https://api.webflow.com/v2${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep raw
  }

  if (!res.ok) {
    const e: WebflowErrorShape = data || {};
    const msg = e.message || e.msg || text || "Webflow error";
    throw new Error(`Webflow ${res.status}: ${msg}`);
  }

  return data;
}

/**
 * GET /v2/sites/:siteId/products?offset=&limit=
 */
export async function listProducts(siteId: string, offset: number, limit: number) {
  return webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`);
}

/**
 * GET /v2/sites/:siteId/products/:productId
 * -> retourne { product, skus: [...] }
 */
export async function getProduct(siteId: string, productId: string) {
  return webflowJson(`/sites/${siteId}/products/${productId}`);
}
