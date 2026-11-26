import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintLiveKitToken, RADIO_ROOM } from "@shared/domain/livekit.ts";

describe("LiveKit radio token", () => {
  it("is a valid HS256 JWT with the room grant and identity", async () => {
    const now = new Date("2026-11-26T18:00:00Z");
    const token = await mintLiveKitToken({
      apiKey: "APIkey123", apiSecret: "s3cr3t-value", identity: "driver:abc", name: "Martín Gómez",
      room: RADIO_ROOM, canPublish: true, ttlSeconds: 3600, metadata: { kind: "driver" }, now,
    });
    const [h, p, s] = token.split(".");
    const expected = createHmac("sha256", "s3cr3t-value").update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "APIkey123", sub: "driver:abc", name: "Martín Gómez",
      exp: now.getTime() / 1000 + 3600,
      video: { room: "soytutaxi-radio", roomJoin: true, canPublish: true, canSubscribe: true, canPublishSources: ["microphone"] },
    });
    expect(JSON.parse(payload.metadata)).toEqual({ kind: "driver" });
  });

  it("listen-only grant cannot publish", async () => {
    const t = await mintLiveKitToken({ apiKey: "k", apiSecret: "s", identity: "x", name: "x", room: RADIO_ROOM, canPublish: false });
    const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    expect(payload.video).toMatchObject({ canPublish: false, canPublishSources: [] });
  });
});
