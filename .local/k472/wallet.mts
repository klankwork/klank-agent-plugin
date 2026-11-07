import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const env = parseEnv(readFileSync("/Users/dustinteander/Documents/GitHub/klank/klank/.env.staging", "utf8"));
const postgres = (await import("postgres")).default;
const sql = postgres(env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15, onnotice() {} });
try {
  const rows = await sql.begin("read only", (tx) => tx`select c.handle, w.address, w.signer_kind, w.status, c.payout_limit_atomic::text lim
    from app.communities c join ledger.community_wallets w on w.community_id=c.id and w.wallet_role='spend' and w.status='active'
    where c.handle in ('staging-builders','staging-research')`);
  console.log(JSON.stringify(rows));
} catch (e) { console.log("FAILED", String((e as Error).message).replace(/(postgres(ql)?|https?):\/\/\S+/g, "<url>").slice(0, 300)); }
await sql.end({ timeout: 3 });
