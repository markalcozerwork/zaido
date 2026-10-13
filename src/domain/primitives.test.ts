import { describe, expect, it } from "vitest";
import {
  formatPhilippineMobile,
  instantSchema,
  line,
  minutesSinceMidnight,
  normalizePhilippinePhone,
  optionalLine,
  optionalParagraphs,
  phMobileSchema,
  phPhoneSchema,
  psgcCodeSchema,
  storagePathSchema,
  timeOfDaySchema,
} from "./primitives";
import { addPesos, formatPeso, pesoAmountSchema, toCentavos } from "./money";
import { addDaysToDate, isValidTimeZone, toZonedParts, zonedTimeToInstant } from "./time";

describe("Philippine phone numbers", () => {
  it.each([
    ["09171234567", "+639171234567"],
    ["0917 123 4567", "+639171234567"],
    ["(0917) 123-4567", "+639171234567"],
    ["9171234567", "+639171234567"],
    ["639171234567", "+639171234567"],
    ["+63 917 123 4567", "+639171234567"],
    ["0063 917 123 4567", "+639171234567"],
  ])("normalises mobile %s", (raw, e164) => {
    expect(normalizePhilippinePhone(raw)).toBe(e164);
    expect(phMobileSchema.parse(raw)).toBe(e164);
  });

  it.each(["0917123456", "08171234567", "+1 415 555 0100", "hello", ""])("rejects %j as a mobile", (raw) => {
    expect(phMobileSchema.safeParse(raw).success).toBe(false);
  });

  it("accepts Metro Manila and provincial landlines for venues", () => {
    expect(phPhoneSchema.parse("(02) 8123 4567")).toBe("+63281234567");
    expect(phPhoneSchema.parse("(049) 536 1234")).toBe("+63495361234");
    expect(phPhoneSchema.parse("0917 123 4567")).toBe("+639171234567");
  });

  it("formats E.164 back to the local style", () => {
    expect(formatPhilippineMobile("+639171234567")).toBe("0917 123 4567");
  });
});

describe("text helpers", () => {
  it("squishes whitespace before measuring length (matches btrim in SQL)", () => {
    expect(line(2, 10).parse("  Juan   dela  ")).toBe("Juan dela");
    expect(line(2, 10).safeParse("   a   ").success).toBe(false);
  });

  it("turns blank optional input into undefined", () => {
    expect(optionalLine(2, 40).parse("   ")).toBeUndefined();
    expect(optionalLine(2, 40).parse(undefined)).toBeUndefined();
    expect(optionalLine(2, 40).safeParse("x").success).toBe(false);
    expect(optionalParagraphs(20).parse("line 1\r\nline 2\n")).toBe("line 1\nline 2");
  });
});

describe("structured strings", () => {
  it("validates PSGC codes", () => {
    expect(psgcCodeSchema.parse(" 1380100001 ")).toBe("1380100001");
    expect(psgcCodeSchema.safeParse("13801").success).toBe(false);
  });

  it("rejects path traversal in storage paths", () => {
    expect(storagePathSchema.safeParse("abc/receipt.jpg").success).toBe(true);
    expect(storagePathSchema.safeParse("abc/../other/receipt.jpg").success).toBe(false);
    expect(storagePathSchema.safeParse("/abs/path.jpg").success).toBe(false);
  });

  it("normalises instants to UTC and rejects offset-less input", () => {
    expect(instantSchema.parse("2026-10-19T18:00:00+08:00")).toBe("2026-10-19T10:00:00.000Z");
    expect(instantSchema.safeParse("2026-10-19T18:00:00").success).toBe(false);
  });

  it("accepts HH:MM, 24:00 and Postgres HH:MM:00", () => {
    expect(timeOfDaySchema.parse("06:00:00")).toBe("06:00");
    expect(timeOfDaySchema.parse("24:00")).toBe("24:00");
    expect(timeOfDaySchema.safeParse("24:30").success).toBe(false);
    expect(timeOfDaySchema.safeParse("6:00").success).toBe(false);
    expect(minutesSinceMidnight("24:00")).toBe(1440);
  });
});

describe("money", () => {
  it("adds pesos exactly", () => {
    expect(addPesos(0.1, 0.2)).toBe(0.3);
    expect(addPesos(450, 112.5, 0.05)).toBe(562.55);
    expect(toCentavos(1234.5)).toBe(123450);
  });

  it("validates amounts to the centavo", () => {
    const s = pesoAmountSchema();
    expect(s.safeParse(100_000).success).toBe(true);
    expect(s.safeParse(100_000.01).success).toBe(false);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(10.005).success).toBe(false);
    expect(s.safeParse(Number.NaN).success).toBe(false);
  });

  it("formats ₱ for the UI", () => {
    expect(formatPeso(1250.5)).toBe("₱1,250.50");
    expect(formatPeso(400, { compact: true })).toBe("₱400");
    expect(formatPeso(400.5, { compact: true })).toBe("₱400.50");
  });
});

describe("time zones", () => {
  it("converts Manila wall-clock time to instants and back", () => {
    const instant = zonedTimeToInstant("2026-10-19", "18:00", "Asia/Manila");
    expect(instant.toISOString()).toBe("2026-10-19T10:00:00.000Z");
    expect(toZonedParts(instant, "Asia/Manila")).toEqual({
      date: "2026-10-19",
      time: "18:00",
      dayOfWeek: 1,
      minuteOfDay: 1080,
    });
  });

  it("treats 24:00 as the following midnight", () => {
    expect(zonedTimeToInstant("2026-10-19", "24:00", "Asia/Manila").toISOString()).toBe(
      "2026-10-19T16:00:00.000Z",
    );
  });

  it("is DST-correct for future non-PH venues", () => {
    // New York: EDT (UTC-4) in October, EST (UTC-5) in December.
    expect(zonedTimeToInstant("2026-10-19", "18:00", "America/New_York").toISOString()).toBe(
      "2026-10-19T22:00:00.000Z",
    );
    expect(zonedTimeToInstant("2026-12-19", "18:00", "America/New_York").toISOString()).toBe(
      "2026-12-19T23:00:00.000Z",
    );
  });

  it("validates zone names and shifts calendar dates", () => {
    expect(isValidTimeZone("Asia/Manila")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
  });
});
