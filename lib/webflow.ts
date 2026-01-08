// lib/webflow.ts

type WebflowOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: any;
};

function getWebflowBaseUrl() {
  // Webflow API v2
  return "https://api.webflow.com/v2";
}

export async function webflowJson(path: string, opts: WebflowOptions = {}) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN env var");

  const url = `${getWebflowBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${res.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}
