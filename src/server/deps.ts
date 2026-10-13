import type { RetryOptions } from "./transport";

/**
 * Server-side dependencies of the server actions (bookings, chat). `now` is the server clock
 * (never taken from the request); tests inject a fixed one.
 */
export interface ServerDeps {
  now?: () => Date;
  retry?: RetryOptions;
}
