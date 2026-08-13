// Verifies the server side of the reconnection contract and the audio level
// observer, using a real Socket.IO client with the same options the browser
// uses. No media is exchanged — this checks the signalling and session
// behaviour that reconnection depends on.
import { io } from "socket.io-client";

const BASE = "http://127.0.0.1:38080";
const ROOM = "Video Production";

const results = [];
const record = (name, ok, detail = "") =>
  results.push({ name, ok, detail });

// ---- log in and keep the session cookie, exactly as a browser would --------
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    usernameOrEmail: "admin",
    password: "correct-horse-battery-staple",
  }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
record("login succeeds", login.status === 200, `status ${login.status}`);
record("session cookie issued", !!cookie, cookie.split("=")[0]);

const socket = io(BASE, {
  query: { room: ROOM },
  extraHeaders: { Cookie: cookie },
  reconnection: true,
  reconnectionDelay: 300,
  reconnectionDelayMax: 2000,
  reconnectionAttempts: Infinity,
  transports: ["websocket"],
});

const seen = {
  connects: 0,
  socketIds: [],
  peers: 0,
  feeds: null,
  feedLevelTicks: 0,
  feedLevelsNonEmpty: 0,
  speakingTicks: 0,
  disconnects: [],
};

socket.on("connect", () => {
  seen.connects += 1;
  seen.socketIds.push(socket.id);
});
socket.on("disconnect", (reason) => seen.disconnects.push(reason));
socket.on("peers", (list) => { seen.peers += 1; });
socket.on("feeds", (list) => { seen.feeds = list; });
socket.on("speaking", () => { seen.speakingTicks += 1; });
socket.on("feed-levels", (levels) => {
  seen.feedLevelTicks += 1;
  if (levels.length > 0) seen.feedLevelsNonEmpty += 1;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  return false;
};

// ---- initial connection ----------------------------------------------------
record("socket connects", await waitFor(() => seen.connects >= 1));
record("receives peer list", await waitFor(() => seen.peers >= 1));

const rtpCaps = await new Promise((resolve) =>
  socket.emit("getRtpCapabilities", resolve)
);
record("router capabilities returned", Array.isArray(rtpCaps?.codecs));

// ---- the room is server-controlled -----------------------------------------
// Ask to consume a producer id that does not belong to this room. The server
// must refuse regardless of what the client claims.
const bogus = await new Promise((resolve) =>
  socket.emit("consume", {
    producerId: "00000000-0000-0000-0000-000000000000",
    rtpCapabilities: rtpCaps,
    transportId: "nope",
  }, resolve)
);
record("consume of unknown transport refused", !!bogus?.error, bogus?.error);

// ---- audio level observer --------------------------------------------------
// Capture is running two synthetic tones, so the observer should be reporting
// level for both feeds continuously.
record("feeds advertised", (seen.feeds?.length ?? 0) > 0,
  `${seen.feeds?.length ?? 0} feeds: ${(seen.feeds || []).map((f) => f.name).join(", ")}`);

// Feed levels are deliberately NOT server-measured: mediasoup's observer reads
// the ssrc-audio-level RTP header extension, which ffmpeg does not send. Feed
// metering is client-side. Assert the server does not claim otherwise.
record("server sends no phantom feed-level events", seen.feedLevelTicks === 0,
  `${seen.feedLevelTicks} ticks`);

// 'speaking' requires a browser producer (only browsers add the header
// extension), which this headless client cannot provide. Verified in a browser
// instead; here we only assert the channel exists and stays quiet.
record("no speaking events without browser producers", seen.speakingTicks === 0,
  `${seen.speakingTicks} ticks`);

// ---- reconnection ----------------------------------------------------------
// Drop the transport the way a Wi-Fi blip would, without calling disconnect().
const idBefore = socket.id;
const connectsBefore = seen.connects;
socket.io.engine.close();

record("disconnect observed", await waitFor(() => seen.disconnects.length >= 1, 5000),
  seen.disconnects.join(","));

const reconnected = await waitFor(() => seen.connects > connectsBefore, 15000);
record("socket reconnects automatically", reconnected);
record("reconnect issues a new socket id", socket.id !== idBefore,
  `${idBefore} -> ${socket.id}`);
record("session survives reconnect (not bounced to auth)",
  reconnected && socket.connected);

// After reconnecting the client must be back in the room and receiving state.
const peersAfter = seen.peers;
record("room state re-delivered after reconnect", peersAfter >= 2,
  `${peersAfter} peer-list deliveries`);

const feedsAfter = await new Promise((resolve) => socket.emit("getFeeds", {}, resolve));
record("feeds queryable after reconnect", (feedsAfter?.length ?? 0) > 0);

socket.disconnect();
await wait(300);

// ---- report ----------------------------------------------------------------
let failed = 0;
for (const { name, ok, detail } of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
