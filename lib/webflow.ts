// lib/webflow.ts

export type WebflowMoney = {
  value: number;      // minor units (ex: centimes)
  unit?: string;      // ex: "EUR"
  currency?: string;  // parfois présent
};

export function moneyToNumber(m?: WebflowMoney | null): number | null {
  if (!m || typeof m.value !== "number") return null;

  const c = (m.currency || m.unit || "EUR").toUpperCase();

  // Monnaies sans décimales (si un jour tu en as dans Webflow)
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  // 24354 -> 243.54 (EUR)
  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

function normalizeV2Path(path: string) {
  // Accepte "sites/..." ou "/v2/sites/..." etc.
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.startsWith("/v2/") ? p : `/v2${p}`;
}

export async function webflowJson(path: string, init: RequestInit = {}) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  const url = `https://api.webflow.com${normalizeV2Path(path)}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webflow ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export type WebflowGetProductResponse = {
  product: {
    id: string;
    fieldData: Record<string, any>;
  };
  skus: Array<{
    id: string;
    fieldData: Record<string, any>;
  }>;
};

export async function getWebflowProductWithSkus(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  // ✅ endpoint correct (sinon 404)
  return webflowJson(
    `/sites/${siteId}/products/${webflowProductId}`
  ) as Promise<WebflowGetProductResponse>;
}
