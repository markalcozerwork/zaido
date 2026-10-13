/**
 * Chat engine server actions (Step 4). Every function takes the caller's
 * Supabase client (created per request with the user's session, so RLS sees
 * the real user), validates untrusted input, and returns an ActionResult.
 * purgeChatMedia is the one service-role job.
 */
export * from "./channels";
export * from "./inbox";
export * from "./media";
export * from "./messages";
