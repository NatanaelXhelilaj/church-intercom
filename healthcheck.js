/**
 * Container healthcheck.
 *
 * Exits 0 only when /api/health reports every subsystem up. Docker restarts the
 * container on repeated failure, which is what turns a wedged mediasoup worker
 * or a lost database connection into an automatic recovery instead of a silent
 * outage nobody notices until Sunday morning.
 *
 * Certificate validation is disabled deliberately: this talks to the local
 * process over loopback, and the deployment uses a self-signed certificate.
 * Scoped to this short-lived process only — the server itself is unaffected.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const port = process.env.PORT || "3000";
const scheme = ["1", "true", "yes", "on"].includes(
  (process.env.HTTPS || "").toLowerCase()
)
  ? "https"
  : "http";

const url = `${scheme}://127.0.0.1:${port}/api/health`;

const timeout = setTimeout(() => {
  console.error("healthcheck: timed out");
  process.exit(1);
}, 5000);

try {
  const response = await fetch(url);

  clearTimeout(timeout);

  if (!response.ok) {
    console.error(`healthcheck: HTTP ${response.status}`);
    console.error(await response.text());
    process.exit(1);
  }

  const body = await response.json();
  if (body.status !== "ok") {
    console.error(`healthcheck: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  clearTimeout(timeout);
  console.error(`healthcheck: ${error.message}`);
  process.exit(1);
}
