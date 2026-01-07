// lib/webflow.ts

export type WebflowMoney = {
  value: number; // minor units (centimes)
  unit?: string; // "EUR"
  currency?: string; // parfois présent
};

export function moneyToNumber(m?: WebflowMoney | null): number | null {
  if (!m || typeof m.value !== "number") return null;

  const c = (m.currency || m.unit || "EUR").toUpperCase();
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

export async function webflowJson(path: string, init: RequestInit = {}) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  const url = `https://api.webflow.com/v2${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webflow ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function webflowListProducts(siteId: string, offset = 0, limit = 100) {
  return webflowJson(`/sites/${siteId}/products?offset=${offset}&limit=${limit}`, { method: "GET" });
}

export async function webflowGetProduct(siteId: string, productId: string) {
  // IMPORTANT: endpoint correct = /v2/sites/{siteId}/products/{productId}
  return webflowJson(`/sites/${siteId}/products/${productId}`, { method: "GET" });
}
