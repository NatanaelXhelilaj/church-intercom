import pg from "pg";
import config from "./config.js";

const { Pool } = pg;

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
});

// An idle client dropped by the network or a Postgres restart emits here. Left
// unhandled this is an uncaught exception that takes the whole intercom down,
// so it is logged and swallowed; `pg` discards the client and the next query
// transparently opens a new one.
pool.on("error", (err) => {
  console.error("Idle database client error (connection will be replaced):", err.message);
});

/**
 * Waits for Postgres to accept connections.
 *
 * Docker's `depends_on: service_healthy` already gates startup, but a USB-stick
 * host can be slow enough that Postgres finishes its healthcheck and then
 * briefly stalls on I/O. Retrying here means a slow boot is a delay rather than
 * a crash loop.
 */
export async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await pool.query("SELECT NOW() AS now");
      console.log("Database connected at", result.rows[0].now);
      return true;
    } catch (error) {
      if (attempt === attempts) {
        console.error(
          `Database unreachable after ${attempts} attempts: ${error.message}`
        );
        throw error;
      }
      console.warn(
        `Database not ready (attempt ${attempt}/${attempts}): ${error.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** Cheap liveness probe used by /api/health. */
export async function checkDatabase() {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function closeDatabase() {
  try {
    await pool.end();
  } catch (error) {
    console.warn("Error closing database pool:", error.message);
  }
}

export default pool;
