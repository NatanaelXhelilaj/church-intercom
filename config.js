import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader. Real environment variables always win, so values injected
 * by Docker Compose override anything in a file. Kept in-tree rather than
 * pulling in `dotenv` because the container has no writable node_modules layer
 * to patch if that dependency ever breaks.
 */
function applyEnvFromFile(filename) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) return;

  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.warn(`Could not read ${filename}: ${error.message}`);
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7) : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    const rawValue = normalized.slice(separatorIndex + 1).trim();
    const quoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));

    const value = quoted
      ? rawValue.slice(1, -1)
      : rawValue.replace(/\s+#.*$/, "");

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

// Only `.env` is read. There is deliberately no `.env.default` fallback: a
// second file that also defines ANNOUNCED_IP and SESSION_SECRET silently wins
// over the defaults below whenever someone forgets it exists, and an
// ANNOUNCED_IP of 127.0.0.1 produces a room that connects but carries no audio.
// Defaults live in this file; `.env.example` documents them.
applyEnvFromFile(".env");

const fatalErrors = [];

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    fatalErrors.push(`${name} must be an integer, got "${raw}"`);
    return fallback;
  }
  return parsed;
}

function str(name, fallback = "") {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * mediasoup needs to advertise an address that LAN clients can actually reach.
 * Guessing wrong is the single most common cause of "connected but no audio",
 * so we auto-detect the primary private IPv4 address and let ANNOUNCED_IP
 * override it when the box is multi-homed.
 */
function detectLanAddress() {
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push(address.address);
    }
  }

  // Prefer the ranges a church LAN actually uses, in the order they're likely.
  const preferred = candidates.find((ip) => /^192\.168\./.test(ip)) ||
    candidates.find((ip) => /^10\./.test(ip)) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));

  return preferred || candidates[0] || "127.0.0.1";
}

const NODE_ENV = str("NODE_ENV", "production");
const IS_PRODUCTION = NODE_ENV === "production";

const HTTPS_ENABLED = bool("HTTPS", false);
const SSL_KEY_PATH = str("SSL_KEY_PATH");
const SSL_CERT_PATH = str("SSL_CERT_PATH");
const SSL_CA_PATH = str("SSL_CA_PATH");

if (HTTPS_ENABLED) {
  if (!SSL_KEY_PATH || !SSL_CERT_PATH) {
    fatalErrors.push(
      "HTTPS=true requires both SSL_KEY_PATH and SSL_CERT_PATH to be set"
    );
  } else {
    for (const [label, filePath] of [
      ["SSL_KEY_PATH", SSL_KEY_PATH],
      ["SSL_CERT_PATH", SSL_CERT_PATH],
      ...(SSL_CA_PATH ? [["SSL_CA_PATH", SSL_CA_PATH]] : []),
    ]) {
      if (!fs.existsSync(filePath)) {
        fatalErrors.push(`${label} points at "${filePath}", which does not exist`);
      }
    }
  }
}

/**
 * BYPASS_AUTH drops the account roster entirely: any username is accepted,
 * without a database. Sign-in is already passwordless, so what this adds is
 * letting someone who is on no roster in. It exists for offline local
 * development and must never be reachable in a deployed install, so we refuse
 * to boot rather than silently running an open intercom.
 */
const BYPASS_AUTH = bool("BYPASS_AUTH", false);
if (BYPASS_AUTH && IS_PRODUCTION) {
  fatalErrors.push(
    "BYPASS_AUTH=true is not permitted when NODE_ENV=production. " +
      "It accepts any username, including one no account exists for. Set " +
      "NODE_ENV=development if you genuinely intend to run without an account " +
      "roster on an isolated machine."
  );
}

const SESSION_SECRET = str("SESSION_SECRET");
const INSECURE_SECRETS = new Set([
  "",
  "change-this-secret-in-production",
  "changeme",
  "secret",
]);

if (INSECURE_SECRETS.has(SESSION_SECRET)) {
  const message =
    'SESSION_SECRET is unset or still the placeholder value. Generate one with:\n' +
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";
  if (IS_PRODUCTION && !BYPASS_AUTH) {
    fatalErrors.push(message);
  } else {
    console.warn(`WARNING: ${message}`);
  }
}

const RTP_PORT_MIN = int("RTP_PORT_MIN", 40000);
const RTP_PORT_MAX = int("RTP_PORT_MAX", 40199);
if (RTP_PORT_MAX <= RTP_PORT_MIN) {
  fatalErrors.push("RTP_PORT_MAX must be greater than RTP_PORT_MIN");
}

/**
 * Each hardware input is published as its own mono feed. Two channels on one
 * interface is the common case (e.g. program feed on 1, talkback on 2), but the
 * list is config-driven so a 4-in interface only needs an env change.
 */
function parseAudioChannels() {
  const count = int("AUDIO_CAPTURE_CHANNELS", 2);
  if (count < 1 || count > 8) {
    fatalErrors.push("AUDIO_CAPTURE_CHANNELS must be between 1 and 8");
    return [];
  }

  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      index,
      id: `feed${number}`,
      name: str(`AUDIO_CHANNEL_${number}_NAME`, `Input ${number}`),
    };
  });
}

const AUDIO_CAPTURE_ENABLED = bool("AUDIO_CAPTURE_ENABLED", false);
const AUDIO_PLAYBACK_ENABLED = bool("AUDIO_PLAYBACK_ENABLED", false);

const config = {
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,

  port: int("PORT", 3000),
  https: {
    enabled: HTTPS_ENABLED,
    keyPath: SSL_KEY_PATH,
    certPath: SSL_CERT_PATH,
    caPath: SSL_CA_PATH,
  },

  announcedIp: str("ANNOUNCED_IP") || detectLanAddress(),
  announcedIpWasDetected: !str("ANNOUNCED_IP"),

  rtp: {
    portMin: RTP_PORT_MIN,
    portMax: RTP_PORT_MAX,
    maxIncomingBitrate: int("MAX_INCOMING_BITRATE", 800000),
    initialAvailableBitrate: int("INITIAL_AVAILABLE_BITRATE", 1000000),
  },

  auth: {
    bypass: BYPASS_AUTH,
    sessionSecret: SESSION_SECRET || "insecure-development-secret",
    // 30 days. Volunteers rotate and a session that expires between Saturday
    // setup and Sunday morning means someone hunting for a login during a
    // service. The cookie is httpOnly and the device is on the church LAN.
    sessionMaxAgeMs: int("SESSION_MAX_AGE_HOURS", 24 * 30) * 60 * 60 * 1000,
    loginRateLimit: {
      windowMs: int("LOGIN_RATE_WINDOW_MS", 60_000),
      maxAttempts: int("LOGIN_RATE_MAX_ATTEMPTS", 10),
    },
    // Seeded on first boot only; ignored once an admin account exists.
    // BOOTSTRAP_ADMIN_PASSWORD is gone: sign-in is passwordless.
    bootstrapAdminUsername: str("BOOTSTRAP_ADMIN_USERNAME", "admin"),
    bootstrapAdminEmail: str("BOOTSTRAP_ADMIN_EMAIL", "admin@church.local"),
  },

  db: {
    host: str("DB_HOST", "localhost"),
    port: int("DB_PORT", 5432),
    database: str("DB_NAME", "church_intercom"),
    user: str("DB_USER", "postgres"),
    password: str("DB_PASSWORD"),
    poolMax: int("DB_POOL_MAX", 10),
    idleTimeoutMillis: int("DB_IDLE_TIMEOUT", 30000),
    connectionTimeoutMillis: int("DB_CONNECTION_TIMEOUT", 5000),
  },

  audio: {
    capture: {
      enabled: AUDIO_CAPTURE_ENABLED,
      // ALSA device string, e.g. "hw:1,0". `default` routes through dmix and
      // adds latency, so we prefer an explicit hardware device.
      device: str("AUDIO_CAPTURE_DEVICE", "hw:1,0"),
      // ffmpeg input format. Normally "alsa". Set to "lavfi" with a generator
      // as the device to exercise the whole capture path without hardware,
      // which is how you verify the box before the interface is wired up:
      //   AUDIO_CAPTURE_FORMAT=lavfi
      //   AUDIO_CAPTURE_DEVICE=aevalsrc=sin(440*2*PI*t)|sin(880*2*PI*t):s=48000:c=stereo
      format: str("AUDIO_CAPTURE_FORMAT", "alsa"),
      sampleRate: int("AUDIO_CAPTURE_SAMPLE_RATE", 48000),
      bitratePerChannel: int("AUDIO_CAPTURE_BITRATE", 64000),
      channels: parseAudioChannels(),
      restartDelayMs: int("AUDIO_RESTART_DELAY_MS", 1000),
      restartDelayMaxMs: int("AUDIO_RESTART_DELAY_MAX_MS", 30000),
    },
    playback: {
      enabled: AUDIO_PLAYBACK_ENABLED,
      device: str("AUDIO_PLAYBACK_DEVICE", "hw:1,0"),
      // ffmpeg output device. "alsa" on the Linux appliance; a Mac used for
      // development writes through "audiotoolbox" instead.
      format: str("AUDIO_PLAYBACK_FORMAT", process.platform === "darwin" ? "audiotoolbox" : "alsa"),
    },
    // Where an admin's runtime choice of sound card is remembered. Kept out of
    // .env because that file is hand-edited and read-only on the appliance.
    settingsPath: str("AUDIO_SETTINGS_PATH", path.join(__dirname, "data", "audio-devices.json")),
  },

  rooms: str(
    "ROOMS",
    "Video Production,media,bashkepunetoret,room4,room5,room6,room7,room8"
  )
    .split(",")
    .map((room) => room.trim())
    .filter(Boolean),

  debugAudio: bool("DEBUG_AUDIO", false),
};

if (config.rooms.length === 0) {
  fatalErrors.push("ROOMS must list at least one room name");
}

if (fatalErrors.length > 0) {
  console.error("\nRefusing to start due to configuration errors:\n");
  for (const error of fatalErrors) {
    console.error(`  - ${error}`);
  }
  console.error("");
  process.exit(1);
}

export default config;
