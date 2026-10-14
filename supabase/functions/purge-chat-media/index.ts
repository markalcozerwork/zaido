// Supabase Edge Function (Deno): removes chat media that no message shows any
// more, through the Storage API (which deletes the file, not just its row).
//
//   * media of deleted or moderated messages (queued by the database)
//   * uploads never sent, older than a day
//   * never media held by an OPEN report (evidence)
//
// Same logic as src/server/chat/media.ts purgeChatMedia (unit-tested there);
// kept standalone because Edge Functions can't import the app's bundler-style
// modules. Deploy and schedule (Dashboard → Integrations → Cron, or pg_cron +
// pg_net) every 15 minutes:
//
//   supabase functions deploy purge-chat-media
//   select cron.schedule('rh-purge-chat-media', '*/15 * * * *', $$
//     select net.http_post(
//       url     := '<project-url>/functions/v1/purge-chat-media',
//       headers := jsonb_build_object('Authorization', 'Bearer ' || <service role key from Vault>));
//   $$);
//
// scripts/post-deploy-check.sql reports a backlog older than two days, which
// means this job isn't running.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const BATCH = 100; // claim size per round (the RPC caps at 1000)
const REMOVE_CHUNK = 100; // Storage accepts at most 1000 paths per remove
const BUDGET_MS = 50_000; // stay under the function's wall-clock limit

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return new Response("missing configuration", { status: 500 });
  // Only callers holding the service key may trigger a purge.
  if (req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return new Response("forbidden", { status: 403 });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const started = Date.now();
  let claimed = 0;
  let removed = 0;
  let failed = 0;

  while (Date.now() - started < BUDGET_MS) {
    const { data: paths, error } = await db.rpc("claim_chat_media_purge", { p_limit: BATCH });
    if (error) return Response.json({ error: error.message, claimed, removed, failed }, { status: 502 });
    const batch = (paths ?? []) as string[];
    if (batch.length === 0) break;
    claimed += batch.length;

    let progressed = false;
    for (let i = 0; i < batch.length; i += REMOVE_CHUNK) {
      const chunk = batch.slice(i, i + REMOVE_CHUNK);
      const { error: removeError } = await db.storage.from("chat-media").remove(chunk);
      if (removeError) {
        failed += chunk.length;
        continue;
      }
      const { error: doneError } = await db.rpc("complete_chat_media_purge", { p_paths: chunk });
      if (doneError)
        return Response.json({ error: doneError.message, claimed, removed, failed }, { status: 502 });
      removed += chunk.length;
      progressed = true;
    }
    // Storage refused a whole round: stop and let the next run retry.
    if (!progressed) break;
  }

  return Response.json({ claimed, removed, failed }, { status: failed > 0 && removed === 0 ? 502 : 200 });
});
