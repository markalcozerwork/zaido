import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../db";

/**
 * The typed Supabase client every server function takes as its first
 * argument. Callers create it per request (Next.js: @supabase/ssr with the
 * user's cookies), so RLS always sees the real user.
 */
export type DbClient = SupabaseClient<Database>;
