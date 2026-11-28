// Integration keys for Edge Functions: the function's own secrets (Supabase dashboard) win; otherwise the
// keys an admin saved on /conexion (Supabase Vault, read with the service role). Refreshed every 30 s.
// deno-lint-ignore no-explicit-any
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }> };

export function secretSource(db: Rpc, env: (k: string) => string, ttlMs = 30_000) {
  let vault: Record<string, string> = {};
  let at = 0;
  return {
    async refresh(force = false) {
      if (!force && Date.now() - at < ttlMs) return;
      at = Date.now();
      try {
        const { data, error } = await db.rpc("secrets_for_functions");
        if (!error && data && typeof data === "object") vault = data;
      } catch { /* keep the last known values */ }
    },
    get(name: string): string { return env(name) || vault[name] || ""; },
  };
}
