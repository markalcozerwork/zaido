/**
 * One Realtime connection carries every channel the app has open, and
 * Supabase caps channels per connection (100). Court grids, booking status,
 * the open conversation and the chat inbox all share that budget, so each
 * subscription registers here, and the inbox (the only elastic user) sizes
 * its group-chat topics to what is left after a reserve for screens.
 */
export const REALTIME_BUDGET = {
  /** Supabase Realtime: channels per client connection. */
  maxChannels: 100,
  /** Kept free for screens that open channels on demand (grid, conversation, typing, booking). */
  reserve: 12,
} as const;

const open = new WeakMap<object, Set<string>>();

export function noteChannelOpened(client: object, topic: string): void {
  let topics = open.get(client);
  if (!topics) {
    topics = new Set();
    open.set(client, topics);
  }
  topics.add(topic);
}

export function noteChannelClosed(client: object, topic: string): void {
  open.get(client)?.delete(topic);
}

export const channelsInUse = (client: object): number => open.get(client)?.size ?? 0;

/** How many more channels an elastic subscriber may open (never negative). */
export const channelsAvailable = (client: object): number =>
  Math.max(0, REALTIME_BUDGET.maxChannels - REALTIME_BUDGET.reserve - channelsInUse(client));
