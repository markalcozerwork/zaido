/**
 * Weekly wall-clock windows (opening hours, coach availability, rate rules)
 * and the overlap rule the database enforces with
 * `EXCLUDE USING gist (…, day_of_week WITH =, hours WITH &&)`.
 */
import { minutesSinceMidnight } from "./primitives";

export interface WeeklyWindow {
  day_of_week: number;
  start: string; // "HH:MM"
  end: string; // "HH:MM" or "24:00"
}

/**
 * Index pairs of windows that overlap on the same weekday. Ranges are
 * half-open [start, end), so 06:00–12:00 and 12:00–18:00 don't overlap.
 */
export function findWeeklyOverlaps(windows: readonly WeeklyWindow[]): Array<[number, number]> {
  const order = windows
    .map((w, index) => ({
      index,
      day: w.day_of_week,
      start: minutesSinceMidnight(w.start),
      end: minutesSinceMidnight(w.end),
    }))
    .sort((a, b) => a.day - b.day || a.start - b.start);

  const overlaps: Array<[number, number]> = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i]!;
    for (let j = i + 1; j < order.length && order[j]!.day === a.day && order[j]!.start < a.end; j++) {
      overlaps.push([a.index, order[j]!.index]);
    }
  }
  return overlaps;
}
