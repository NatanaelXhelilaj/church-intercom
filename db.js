import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "church_intercom",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  max: parseInt(process.env.DB_POOL_MAX || "20", 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || "5000", 10),
});

pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err);
});

// Test connection on startup
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("Failed to connect to database:", err.message);
    console.error("Please ensure PostgreSQL is running and credentials are correct");
  } else {
    console.log("Database connected successfully at", res.rows[0].now);
  }
});

export default pool;
