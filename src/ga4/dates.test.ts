import { describe, expect, it } from "vitest";
import { DateRangeError, parseDateRange, precedingRange, resolveToDate } from "./dates.js";

// A Wednesday, so week boundaries are unambiguous.
const TODAY = new Date("2026-08-12T09:30:00Z");

describe("parseDateRange — relative forms Google resolves in property time", () => {
  it("keeps 'today' as a token rather than an absolute date", () => {
    expect(parseDateRange("today", TODAY)).toMatchObject({
      startDate: "today",
      endDate: "today",
    });
  });

  it("marks today's data as partial so a model does not read it as final", () => {
    expect(parseDateRange("today", TODAY).label).toContain("partial");
  });

  it("keeps 'yesterday' as a token", () => {
    expect(parseDateRange("yesterday", TODAY)).toMatchObject({
      startDate: "yesterday",
      endDate: "yesterday",
    });
  });

  it.each([
    ["last 7 days", "7daysAgo"],
    ["last 28 days", "28daysAgo"],
    ["last 30 days", "30daysAgo"],
    ["90 days", "90daysAgo"],
    ["7d", "7daysAgo"],
    ["1 day", "1daysAgo"],
  ])("reads %s as %s..yesterday", (input, startDate) => {
    expect(parseDateRange(input, TODAY)).toMatchObject({ startDate, endDate: "yesterday" });
  });

  it("ends relative ranges yesterday, so a partial today cannot skew a comparison", () => {
    expect(parseDateRange("last 7 days", TODAY).endDate).toBe("yesterday");
  });

  it("attaches no timezone caveat to token-based ranges", () => {
    expect(parseDateRange("last 7 days", TODAY).timezoneNote).toBeUndefined();
  });

  it("is case and whitespace insensitive", () => {
    expect(parseDateRange("  LAST   7   DAYS ", TODAY).startDate).toBe("7daysAgo");
  });
});

describe("parseDateRange — explicit dates", () => {
  it("accepts a single ISO date as a one-day range", () => {
    expect(parseDateRange("2026-03-04", TODAY)).toMatchObject({
      startDate: "2026-03-04",
      endDate: "2026-03-04",
    });
  });

  it.each(["2026-01-01..2026-01-31", "2026-01-01 to 2026-01-31", "2026-01-01 - 2026-01-31"])(
    "accepts the range spelling %s",
    (input) => {
      expect(parseDateRange(input, TODAY)).toMatchObject({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
    },
  );

  it("refuses a backwards range instead of silently returning nothing", () => {
    expect(() => parseDateRange("2026-02-01..2026-01-01", TODAY)).toThrow(/starts after it ends/);
  });
});

describe("parseDateRange — calendar boundaries", () => {
  it("starts 'this week' on Monday", () => {
    // 2026-08-12 is a Wednesday; that week's Monday is 2026-08-10.
    expect(parseDateRange("this week", TODAY)).toMatchObject({
      startDate: "2026-08-10",
      endDate: "today",
    });
  });

  it("covers the whole of last week, Monday to Sunday", () => {
    expect(parseDateRange("last week", TODAY)).toMatchObject({
      startDate: "2026-08-03",
      endDate: "2026-08-09",
    });
  });

  it("runs 'this month' from the first to today", () => {
    expect(parseDateRange("this month", TODAY)).toMatchObject({
      startDate: "2026-08-01",
      endDate: "today",
    });
  });

  it("covers all of last month, including its real final day", () => {
    expect(parseDateRange("last month", TODAY)).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
  });

  it("handles last month across a year boundary", () => {
    expect(parseDateRange("last month", new Date("2026-01-15T00:00:00Z"))).toMatchObject({
      startDate: "2025-12-01",
      endDate: "2025-12-31",
    });
  });

  it("gets February right in a leap year", () => {
    expect(parseDateRange("last month", new Date("2028-03-10T00:00:00Z"))).toMatchObject({
      startDate: "2028-02-01",
      endDate: "2028-02-29",
    });
  });

  it("covers all of last year", () => {
    expect(parseDateRange("last year", TODAY)).toMatchObject({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  });

  it("warns that locally computed boundaries may not match property time", () => {
    expect(parseDateRange("last month", TODAY).timezoneNote).toMatch(/timezone/i);
  });
});

describe("parseDateRange — rejections", () => {
  it.each(["", "   ", "sometime last spring", "0 days", "next week"])(
    "rejects %o and lists what it accepts",
    (input) => {
      expect(() => parseDateRange(input, TODAY)).toThrow(DateRangeError);
      expect(() => parseDateRange(input, TODAY)).toThrow(/last 7 days/);
    },
  );
});

describe("resolveToDate", () => {
  it.each([
    ["today", "2026-08-12"],
    ["yesterday", "2026-08-11"],
    ["7daysAgo", "2026-08-05"],
    ["2026-01-01", "2026-01-01"],
  ])("resolves %s to %s", (input, expected) => {
    expect(resolveToDate(input, TODAY).toISOString().slice(0, 10)).toBe(expected);
  });
});

describe("precedingRange", () => {
  it("returns the seven days immediately before the last seven", () => {
    const current = parseDateRange("last 7 days", TODAY); // 2026-08-05 .. 2026-08-11
    expect(precedingRange(current, TODAY)).toMatchObject({
      startDate: "2026-07-29",
      endDate: "2026-08-04",
    });
  });

  it("does not overlap the current range by even a day", () => {
    const current = parseDateRange("last 30 days", TODAY);
    const previous = precedingRange(current, TODAY);
    expect(previous.endDate < resolveToDate(current.startDate, TODAY).toISOString().slice(0, 10)).toBe(
      true,
    );
  });

  it("matches the current range's length exactly", () => {
    const current = parseDateRange("2026-01-01..2026-01-31", TODAY);
    const previous = precedingRange(current, TODAY);
    expect(previous).toMatchObject({ startDate: "2025-12-01", endDate: "2025-12-31" });
    expect(previous.label).toBe("previous 31 days");
  });

  it("handles a single-day range", () => {
    const previous = precedingRange(parseDateRange("yesterday", TODAY), TODAY);
    expect(previous).toMatchObject({ startDate: "2026-08-10", endDate: "2026-08-10" });
    expect(previous.label).toBe("previous 1 day");
  });
});
