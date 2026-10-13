import { describe, expect, it } from "vitest";
import { clientAs, createUser, createVenue } from "./support";

describe("PostgREST harness", () => {
  it("anon reads public data, users are isolated by RLS, RPCs are callable", async () => {
    const { venueId, courtId } = await createVenue();
    const anon = clientAs(null);
    const { data: venue, error } = await anon.from("venues").select("id, name").eq("id", venueId).single();
    expect(error).toBeNull();
    expect(venue?.id).toBe(venueId);

    const bookingsAsAnon = await anon.from("bookings").select("id").limit(1);
    expect(bookingsAsAnon.error?.code).toBe("42501");

    const player = clientAs(await createUser("Player"));
    const quote = await player.rpc("quote_court_booking", {
      p_court_id: courtId,
      p_start: "2030-01-07T02:00:00Z",
      p_end: "2030-01-07T03:00:00Z",
    });
    expect(quote.error).toBeNull();
    expect(quote.data?.[0]?.total_amount).toBe(400);
  });
});
