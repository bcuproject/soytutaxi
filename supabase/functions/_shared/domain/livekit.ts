// LiveKit access tokens (HS256 JWT) minted with WebCrypto — no SDK needed in Deno or tests.
// Grants follow LiveKit's VideoGrant claim: https://docs.livekit.io/home/get-started/authentication/

const enc = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RadioGrant {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  room: string;
  canPublish: boolean;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export async function mintLiveKitToken(g: RadioGrant): Promise<string> {
  const iat = Math.floor((g.now ?? new Date()).getTime() / 1000);
  const payload = {
    iss: g.apiKey,
    sub: g.identity,
    name: g.name,
    nbf: iat - 10,
    iat,
    exp: iat + (g.ttlSeconds ?? 4 * 3600),
    metadata: g.metadata ? JSON.stringify(g.metadata) : undefined,
    video: {
      room: g.room,
      roomJoin: true,
      canPublish: g.canPublish,
      canPublishSources: g.canPublish ? ["microphone"] : [],
      canSubscribe: true,
      canPublishData: false,
    },
  };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(g.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export const RADIO_ROOM = "soytutaxi-radio";
