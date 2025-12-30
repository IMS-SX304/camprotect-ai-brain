export async function GET(request: Request) {
  console.log("HIT /ai/api/health", new URL(request.url).pathname);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
