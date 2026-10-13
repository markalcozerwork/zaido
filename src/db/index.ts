/**
 * Typed access to the database schema.
 *
 * `database.types.ts` is generated from `supabase/migrations` (see
 * `npm run db:types`) and verified in CI, so these aliases always match the
 * real tables, enums and RPCs.
 */
import type { Database } from "./database.types";

export type { Database, Json, Tables, TablesInsert, TablesUpdate, Enums } from "./database.types";
export { Constants } from "./database.types";

type PublicSchema = Database["public"];

export type TableName = keyof PublicSchema["Tables"];
export type Row<T extends TableName> = PublicSchema["Tables"][T]["Row"];
export type InsertRow<T extends TableName> = PublicSchema["Tables"][T]["Insert"];
export type UpdateRow<T extends TableName> = PublicSchema["Tables"][T]["Update"];

export type DbEnumName = keyof PublicSchema["Enums"];
export type DbEnum<E extends DbEnumName> = PublicSchema["Enums"][E];

export type RpcName = Exclude<keyof PublicSchema["Functions"], "timemultirange">;
export type RpcArgs<F extends RpcName> = PublicSchema["Functions"][F]["Args"];
export type RpcReturns<F extends RpcName> = PublicSchema["Functions"][F]["Returns"];
