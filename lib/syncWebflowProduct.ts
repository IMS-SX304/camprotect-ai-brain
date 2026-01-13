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
  // Webflow renvoie souvent en cents (>=1000) -> on sécurise
  if (v >= 1000) return Math.round(v) / 100;
  return v;
}

function camprotectUrlFromSlug(slug?: string | null): string | null {
  const base = (process.env.CAMPROTECT_BASE_URL || "https://www.camprotect.fr").replace(/\/$/, "");
  if (!slug) return null;
  return `${base}/product/${slug}`;
}

// -------- compat helpers --------
function toStr(v: any): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normLower(s: any): string {
  return toStr(s).toLowerCase().trim();
}

function extractIntFromText(text: string): number | null {
  const m = text.match(/(\d{1,2})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractChannelsFromAny(name: string, pfd: Record<string, any>): number | null {
  // Priorité: champ “nombre de canaux” si tu l’as (souvent texte "4 canaux IP")
  const c1 = normLower(pfd["nombre-de-canaux"] || pfd["nombre-de-canaux-filtre"]);
  if (c1) {
    const n = extractIntFromText(c1);
    if (n) return n;
  }

  // Fallback: name
  const t = normLower(name);
  const m = t.match(/(\d{1,2})\s*(canaux|ch|voies)\b/);
  if (m) return Number(m[1]);
  return null;
}

function detectFamily(name: string, pfd: Record<string, any>) {
  const t = `${normLower(name)} ${normLower(pfd["type-de-produit"])} ${normLower(pfd["type-d-enregistreur"])} ${normLower(
    pfd["technologie-de-camera"] || pfd["technologie"]
  )}`;

  if (t.includes("ajax") || normLower(pfd["raccordement"]) === "radio") return "AJAX";
  if (t.includes("switch")) return "SWITCH";
  if (t.includes("kit")) return "KIT";
  if (t.includes("camera") || t.includes("caméra")) return "CAMERA";
  if (t.includes("xvr")) return "XVR";
  if (t.includes("dvr")) return "DVR";
  if (t.includes("nvr") || t.includes("enregistreur")) return "NVR";
  return "OTHER";
}

function detectTech(name: string, pfd: Record<string, any>, family: string) {
  const t = `${normLower(name)} ${normLower(pfd["technologie"])} ${normLower(pfd["technologie-de-camera"])} ${normLower(
    pfd["compatibilite-camera"]
  )} ${normLower(pfd["raccordement"])}`;

  if (family === "AJAX") return "RADIO";
  if (t.includes("radio")) return "RADIO";
  if (t.includes("coax") || t.includes("tvi") || t.includes("cvi") || t.includes("ahd") || t.includes("cvbs") || t.includes("kx6")) return "COAX";
  if (t.includes("ip") || t.includes("réseau") || t.includes("reseau") || t.includes("onvif") || t.includes("nvr")) return "IP";
  return "OTHER";
}

function detectPoE(name: string, pfd: Record<string, any>, family: string, tech: string) {
  const t = `${normLower(name)} ${normLower(pfd["alimentation"])} ${normLower(pfd["port-et-connectivite"])} ${normLower(
    pfd["budget-poe"]
  )}`;

  if (t.includes("poe")) return true;
  // Caméra IP: si alimentation contient "PoE"
  if (family === "CAMERA" && tech === "IP" && t.includes("poe")) return true;
  return false;
}

function detectPoEPorts(name: string, pfd: Record<string, any>) {
  // Si tu as “Nombre de port PoE” en champ select (souvent ID) -> pas exploitable direct.
  // On parse plutôt “Port et connectivité” si tu le remplis (ex: "4 ports PoE")
  const t = `${normLower(name)} ${normLower(pfd["port-et-connectivite"])} ${normLower(pfd["nombre-de-port"])}`;
  const m = t.match(/(\d{1,2})\s*(ports?)\s*(poe)/);
  if (m) return Number(m[1]);
  return null;
}

function detectStorageBays(pfd: Record<string, any>) {
  // “Stockage filtre : 1” (nb HDD)
  const s = pfd["stockage-filtre"];
  if (typeof s === "number") return s;
  const t = normLower(s);
  const n = extractIntFromText(t);
  return n ?? null;
}

function detectCable(tech: string) {
  if (tech === "IP") return "RJ45";
  if (tech === "COAX") return "KX6";
  return null;
}

function detectPower(pfd: Record<string, any>, poe: boolean, family: string) {
  const t = normLower(pfd["alimentation"]);
  if (family === "AJAX" && (t.includes("pile") || t.includes("cr123"))) return "BATTERY";
  if (poe) return "POE";
  if (t.includes("12v")) return "12V";
  if (t.includes("100-240") || t.includes("230") || t.includes("ac")) return "230V";
  return null;
}

function detectOnvif(pfd: Record<string, any>) {
  const t = normLower(pfd["compatibilite-camera"]);
  if (!t) return null;
  return t.includes("onvif");
}

function extractMaxMP(pfd: Record<string, any>) {
  // Exemple: “jusqu’à 32 MP”
  const hay = `${normLower(pfd["description-complete"])} ${normLower(pfd["resolution-d-enregistrement"])} ${normLower(pfd["compatibilite-camera"])}`;
  const m = hay.match(/(\d{1,2})\s*mp/);
  if (!m) return null;
  return Number(m[1]);
}

function buildCompat(productName: string, pfd: Record<string, any>) {
  const family = detectFamily(productName, pfd);
  const tech = detectTech(productName, pfd, family);
  const channels = extractChannelsFromAny(productName, pfd);
  const poe = detectPoE(productName, pfd, family, tech);
  const poe_ports = detectPoEPorts(productName, pfd);
  const storage_bays = detectStorageBays(pfd);
  const cable = detectCable(tech);
  const power = detectPower(pfd, poe, family);
  const onvif = detectOnvif(pfd);
  const max_mp = extractMaxMP(pfd);

  return { family, tech, poe, channels, poe_ports, storage_bays, cable, power, onvif, max_mp };
}

// -------- main sync --------
export async function syncWebflowProduct(webflowProductId: string) {
  const siteId = process.env.WEBFLOW_SITE_ID;
  if (!siteId) throw new Error("Missing WEBFLOW_SITE_ID");

  const data = await webflowJson(`/sites/${siteId}/products/${webflowProductId}`, { method: "GET" });

  const product: WebflowProduct | undefined = data?.product;
  const skus: WebflowSku[] = Array.isArray(data?.skus) ? data.skus : [];

  if (!product?.id) throw new Error("Webflow product payload missing product.id");

  const pfd: Record<string, any> = product.fieldData || {};
  const name = toStr(pfd.name || "");
  const slug = toStr(pfd.slug || "").trim();
  const url = camprotectUrlFromSlug(slug);

  // default sku
  const defaultSkuId = pfd["default-sku"];
  const defaultSku = skus.find((s) => s.id === defaultSkuId) || skus[0];

  const skuCode =
    (toStr(defaultSku?.fieldData?.sku) ||
      toStr(pfd["product-reference"]) ||
      toStr(pfd["code-fabricant"]) ||
      "").trim() || null;

  // min price from variants
  const prices = skus
    .map((s) => toMoney(s.fieldData?.price ?? null))
    .filter((x): x is number => typeof x === "number");
  const minPrice = prices.length ? Math.min(...prices) : null;

  // compat normalization
  const compat = buildCompat(name, pfd);

  const supa = supabaseAdmin();

  // product row (assumes your columns exist)
  const productRow: any = {
    webflow_product_id: product.id,
    slug: slug || null,
    url: url,
    name: name || null,
    description: toStr(pfd.description || "").trim() || null,

    sku: skuCode,
    price: minPrice,
    currency: "EUR",

    altword: toStr(pfd.altword || "").trim() || null,
    benefice_court: toStr(pfd["benefice-court"] || "").trim() || null,
    meta_description: toStr(pfd["meta-description"] || "").trim() || null,
    fiche_technique_url: (pfd["fiche-technique-du-produit"] as any)?.url || pfd["fiche-technique-url"] || null,

    payload: {
      ...pfd,
      camprotect_url: url,
      compat, // ✅ clé importante
    },
  };

  const { data: upProd, error: upProdErr } = await supa
    .from("products")
    .upsert(productRow, { onConflict: "webflow_product_id" })
    .select("id")
    .single();

  if (upProdErr) throw new Error(`Supabase products upsert failed: ${upProdErr.message}`);

  const productId = upProd?.id;
  if (!productId) throw new Error("Supabase products upsert did not return id");

  // variants
  const variantRows = skus.map((s) => {
    const sfd = s.fieldData || {};
    return {
      webflow_sku_id: s.id,
      webflow_product_id: product.id,
      product_id: productId,
      sku: toStr(sfd.sku || "").trim() || null,
      title: toStr(sfd.name || "").trim() || null,
      slug: toStr(sfd.slug || "").trim() || null,
      price: toMoney(sfd.price ?? null),
      currency: toStr(sfd.price?.unit || "EUR"),
      option_values: sfd["sku-values"] || null,
      payload: sfd,
    };
  });

  if (variantRows.length) {
    const { error: upVarErr } = await supa
      .from("product_variants")
      .upsert(variantRows, { onConflict: "webflow_sku_id" });

    if (upVarErr) throw new Error(`Supabase variants upsert failed: ${upVarErr.message}`);
  }

  return { ok: true, productId, variants: variantRows.length, compat };
}
