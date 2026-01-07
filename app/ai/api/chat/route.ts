// 1) Lookup direct produit si SKU détecté (priorité)
const sku = extractSku(input);
let productContext = "";
let productUrl: string | null = null;

if (sku) {
  // A) On cherche d'abord dans les variantes
  const { data: v, error: vErr } = await supa
    .from("product_variants")
    .select("sku,price,currency,slug,product_id,products:product_id(id,webflow_product_id,slug,url,name,brand,product_reference,description_complete,meta_description,altword,payload)")
    .eq("sku", sku)
    .maybeSingle();

  if (!vErr && v?.products) {
    const p = v.products as any;

    productUrl = normalizeUrl(p.url || (p.slug ? `https://www.camprotect.fr/product/${p.slug}` : null));
    const priceStr =
      v.price !== null && v.price !== undefined ? `${v.price} ${v.currency || "EUR"}` : "N/A";

    productContext =
      `### Produit CamProtect (variante)\n` +
      `SKU: ${v.sku}\n` +
      `Nom: ${p.name || "N/A"}\n` +
      `Marque: ${p.brand || "N/A"}\n` +
      `Référence: ${p.product_reference || "N/A"}\n` +
      `Prix: ${priceStr}\n` +
      `Lien CamProtect: ${productUrl || "N/A"}\n`;
  } else {
    // B) fallback produits simples (sans variantes)
    const { data: p, error: pErr } = await supa
      .from("products")
      .select("sku,name,brand,product_type,url,price,currency,description,payload")
      .eq("sku", sku)
      .maybeSingle();

    if (!pErr && p) {
      productUrl = normalizeUrl(p.url);
      const priceStr =
        p.price !== null && p.price !== undefined ? `${p.price} ${p.currency || "EUR"}` : "N/A";

      productContext =
        `### Produit CamProtect (source de vérité)\n` +
        `SKU: ${p.sku}\n` +
        `Nom: ${p.name}\n` +
        `Marque: ${p.brand || "N/A"}\n` +
        `Prix: ${priceStr}\n` +
        `Lien CamProtect: ${productUrl || "N/A"}\n` +
        `Description: ${p.description || "N/A"}\n`;
    }
  }
}
