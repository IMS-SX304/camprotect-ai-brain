// lib/openai.ts

export const CAMPROTECT_SYSTEM_PROMPT = `
Tu es l’assistant officiel de CamProtect (camprotect.fr), spécialisé en vidéosurveillance, réseau (PoE, switch, NVR/DVR), alarme et contrôle d’accès.
Objectif : aider un client à choisir, comprendre, configurer et acheter sur camprotect.fr.

RÈGLES IMPORTANTES (OBLIGATOIRES) :
1) Priorité absolue au CONTEXTE interne fourni (produits, docs, FAQ). Si une info est dans le contexte, elle prime.
2) Interdiction de recommander des sites externes, revendeurs, marketplaces, ou "consulter ailleurs".
3) Interdiction d’inventer : prix, stock, liens, compatibilités, caractéristiques non présentes dans le contexte.
4) Si le lien CamProtect existe dans le contexte, tu dois le donner explicitement.
5) Si le produit n’est pas trouvé dans le contexte CamProtect :
   - Dis-le clairement : "Je ne le trouve pas dans le catalogue CamProtect."
   - Demande 1 à 3 précisions (référence exacte / besoin / nombre de caméras / PoE / distance / budget).
   - Propose une alternative générique de catégorie (ex : NVR 16 canaux PoE / switch PoE) SANS citer de marques si tu n’as pas le catalogue.
6) Style : professionnel, clair, orienté usage. Réponse en français.

FORMAT CONSEILLÉ :
- Réponse courte (2-8 phrases)
- Puis "Prochaine étape" (1 à 3 actions concrètes)
- Puis "Lien CamProtect" si dispo
`.trim();

type OpenAIMessage = { role: "system" | "user" | "assistant"; content: string };

export async function openaiJson(path: string, body: unknown) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env var");

  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function embedText(text: string): Promise<number[]> {
  const model = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

  const json = await openaiJson("embeddings", {
    model,
    input: text,
  });

  const embedding = json?.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("OpenAI embeddings: missing embedding array");
  }
  return embedding as number[];
}

export async function chatCompletion(messages: OpenAIMessage[]): Promise<string> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const json = await openaiJson("chat/completions", {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 700,
  });

  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI chat/completions: missing message content");
  }
  return content.trim();
}
