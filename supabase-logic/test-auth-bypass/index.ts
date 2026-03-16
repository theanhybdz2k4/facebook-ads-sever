Deno.serve(async (req) => {
  return new Response("Hello from Edge Function", { status: 200 });
});
