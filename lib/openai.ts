export async function openaiJson(path: string, body: unknown) {
  const apiKey = process.env.OPENAI_API_KEY!;
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
  return JSON.parse(text);
}
