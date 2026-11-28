import { describe, expect, it } from "vitest";
import { diffNew, SOURCE_ES } from "../../src/components/NewBookings";

const row = (id: string, createdAt: string, state = "needs_driver") => ({ id, createdAt, state }) as never;

describe("new booking alerts", () => {
  const since = "2026-11-28T09:00:00Z";
  it("alerts only for unseen, not-yet-alerted, recent, non-cancelled bookings", () => {
    const rows = [
      row("a", "2026-11-28T09:10:00Z"),
      row("b", "2026-11-28T09:11:00Z"),
      row("c", "2026-11-28T08:00:00Z"),
      row("d", "2026-11-28T09:12:00Z", "cancelled"),
      row("e", "2026-11-28T09:13:00Z"),
    ];
    const got = diffNew(rows, new Set(["a"]), new Set(["e"]), since).map((r: { id: string }) => r.id);
    expect(got).toEqual(["b"]);
  });
  it("labels every booking channel", () => {
    for (const s of ["web", "whatsapp", "voice", "phone", "staff"]) expect(SOURCE_ES[s].label).toBeTruthy();
  });
});
