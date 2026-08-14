import express from "express";
import http from "http";
import https from "https";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import session from "express-session";
import cookieParser from "cookie-parser";
import pgSession from "connect-pg-simple";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import config from "./config.js";
import { AudioCapture, AudioPlayback } from "./audio.js";
import {
  registerUser,
  loginUser,
  getUserById,
  requireAuth,
  requireAdmin,
  authenticateSocket,
  bootstrapAdminUser,
} from "./auth.js";
import {
  describeAudioDevices,
  loadDeviceSelection,
  saveDeviceSelection,
} from "./devices.js";
import pool, { waitForDatabase, checkDatabase, closeDatabase } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixed-window rate limiter keyed by client address.
 *
 * Deliberately in-memory: this is a single-process LAN appliance, so a shared
 * store would add a failure mode without buying anything. Entries are swept on
 * write so an attacker cannot grow the map without bound.
 */
function createRateLimiter({ windowMs, maxAttempts }) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";

    for (const [entryKey, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(entryKey);
    }

    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > maxAttempts) {
      const retryAfter = Math.ceil((windowMs - (now - entry.start)) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${retryAfter} seconds.`,
      });
    }

    return next();
  };
}

async function start() {
  const app = express();
  app.set("trust proxy", false);

  let server;
  if (config.https.enabled) {
    const httpsOptions = {
      key: fs.readFileSync(config.https.keyPath),
      cert: fs.readFileSync(config.https.certPath),
      // iOS and Android both refuse to capture a microphone unless the whole
      // origin is properly secure, and they are strict about how: TLS 1.2 or
      // better, and a certificate chain the device actually trusts. Anything
      // older here is not "less secure", it is a phone that silently cannot
      // join the room.
      minVersion: "TLSv1.2",
      honorCipherOrder: true,
    };
    if (config.https.caPath) {
      httpsOptions.ca = fs.readFileSync(config.https.caPath);
    }
    server = https.createServer(httpsOptions, app);
  } else {
    server = http.createServer(app);
    console.warn(
      "WARNING: running over plain HTTP. Browsers block microphone access on " +
        "non-HTTPS origins other than localhost, so phones and tablets on the " +
        "LAN will not be able to join. Enable HTTPS for any real deployment."
    );
  }

  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: true, limit: "64kb" }));
  app.use(cookieParser());

  // ---------------------------------------------------------------- sessions

  const sessionConfig = {
    name: "intercom.sid",
    secret: config.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // Must track the actual scheme: a `secure` cookie is never sent over
      // plain HTTP, and a non-secure cookie over HTTPS is needlessly weak.
      secure: config.https.enabled,
      httpOnly: true,
      maxAge: config.auth.sessionMaxAgeMs,
      sameSite: "lax",
    },
  };

  if (config.auth.bypass) {
    console.warn("BYPASS_AUTH enabled - using in-memory session store");
  } else {
    const PgStore = pgSession(session);
    sessionConfig.store = new PgStore({
      pool,
      tableName: "sessions",
      createTableIfMissing: true,
      // Sweep expired rows infrequently; every write costs USB flash endurance.
      pruneSessionInterval: 60 * 60,
    });
  }

  const sessionMiddleware = session(sessionConfig);
  app.use(sessionMiddleware);

  // ------------------------------------------------------------------ routes

  const loginLimiter = createRateLimiter(config.auth.loginRateLimit);

  app.post("/api/login", loginLimiter, async (req, res) => {
    const { usernameOrEmail, password } = req.body || {};

    try {
      const user = await loginUser(usernameOrEmail, password);

      // Rotate the session id on privilege change to prevent session fixation.
      req.session.regenerate((regenerateError) => {
        if (regenerateError) {
          console.error("Session regenerate failed:", regenerateError.message);
          return res.status(500).json({ error: "Could not start session" });
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.displayName = user.displayName;
        req.session.isAdmin = user.isAdmin;

        req.session.save((saveError) => {
          if (saveError) {
            console.error("Session save failed:", saveError.message);
            return res.status(500).json({ error: "Could not start session" });
          }
          res.json({
            success: true,
            user: {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              isAdmin: user.isAdmin,
            },
          });
        });
      });
    } catch (error) {
      console.warn(`Failed login for "${usernameOrEmail}": ${error.message}`);
      res.status(401).json({ error: "Invalid username or password" });
    }
  });

  // Self-registration is off by default: an intercom is not a public service,
  // and an open endpoint lets anyone on the LAN grant themselves a seat.
  app.post("/api/register", loginLimiter, requireAuth, async (req, res) => {
    if (!req.session.isAdmin) {
      return res.status(403).json({ error: "Only an administrator can add users" });
    }

    const { username, email, password, displayName, isAdmin } = req.body || {};
    if (!username || !email || !password || !displayName) {
      return res.status(400).json({ error: "All fields are required" });
    }

    try {
      const user = await registerUser(
        username,
        email,
        password,
        displayName,
        !!isAdmin
      );
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          isAdmin: user.is_admin,
        },
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        console.error("Logout error:", error.message);
        return res.status(500).json({ error: "Logout failed" });
      }
      res.clearCookie("intercom.sid");
      res.json({ success: true });
    });
  });

  app.get("/api/user", requireAuth, async (req, res) => {
    try {
      const user = await getUserById(req.session.userId, req.session);
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
      });
    } catch (error) {
      console.error("Get user error:", error.message);
      res.status(500).json({ error: "Could not load user" });
    }
  });

  // Single source of truth for the room list, so the client no longer keeps a
  // duplicate copy that has to be edited in lockstep with the server.
  app.get("/api/rooms", requireAuth, (req, res) => {
    res.json({ rooms: config.rooms });
  });

  // -------------------------------------------------------------- mediasoup

  const worker = await mediasoup.createWorker({
    rtcMinPort: config.rtp.portMin,
    rtcMaxPort: config.rtp.portMax,
    logLevel: config.debugAudio ? "debug" : "warn",
  });

  let shuttingDown = false;

  worker.on("died", () => {
    console.error("mediasoup worker died - exiting so the supervisor restarts us");
    shutdown("worker-died", 1);
  });

  const router = await worker.createRouter({
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    ],
  });

  const capture = new AudioCapture(router);
  const playback = new AudioPlayback(router);

  // A device an admin picked previously wins over the .env default, and has to
  // be applied before capture starts or the first ffmpeg opens the wrong card.
  const savedDevices = loadDeviceSelection();
  if (savedDevices.captureDevice) {
    config.audio.capture.device = savedDevices.captureDevice;
  }
  if (savedDevices.playbackDevice) {
    config.audio.playback.device = savedDevices.playbackDevice;
  }

  await capture.start();

  // ------------------------------------------------- server audio interfaces

  // Admin-only: this chooses which sound card the whole building hears and is
  // heard through. requireAdmin re-derives the rule rather than trusting a
  // long-lived session cookie.
  app.get("/api/audio/devices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const devices = await describeAudioDevices({
        captureDevice: config.audio.capture.device,
        playbackDevice: config.audio.playback.device,
      });
      res.json({
        ...devices,
        capture: { enabled: config.audio.capture.enabled, running: capture.running },
        playback: { enabled: config.audio.playback.enabled, active: playback.active },
      });
    } catch (error) {
      console.error("Device list error:", error.message);
      res.status(500).json({ error: "Could not list the server's audio devices" });
    }
  });

  app.post("/api/audio/devices", requireAuth, requireAdmin, async (req, res) => {
    const { inputDevice, outputDevice } = req.body || {};

    try {
      const devices = await describeAudioDevices({
        captureDevice: config.audio.capture.device,
        playbackDevice: config.audio.playback.device,
      });

      // Every value must be one the server itself just reported. These strings
      // become ffmpeg arguments, and an allowlist is the difference between
      // choosing a sound card and choosing what ffmpeg opens.
      const resolve = (value, list, label) => {
        if (value == null || value === "") return null;
        if (typeof value !== "string" || !list.some((device) => device.id === value)) {
          throw new Error(`Unknown ${label} device`);
        }
        return value;
      };

      const nextInput = resolve(inputDevice, devices.input, "input");
      const nextOutput = resolve(outputDevice, devices.output, "output");

      const captureChanged = nextInput ? capture.setDevice(nextInput) : false;
      const playbackInterrupted = nextOutput ? await playback.setDevice(nextOutput) : false;

      saveDeviceSelection({
        captureDevice: config.audio.capture.device,
        playbackDevice: config.audio.playback.device,
      });

      if (playbackInterrupted) {
        // Whoever held the output still believes they are streaming. `io` is
        // created further down in start(); by the time a request lands here it
        // exists.
        io.emit("playback-state", playback.getStatus());
      }

      res.json({
        success: true,
        selected: {
          input: config.audio.capture.device,
          output: config.audio.playback.device,
        },
        captureRestarted: captureChanged,
        playbackInterrupted,
      });
    } catch (error) {
      console.warn("Device selection rejected:", error.message);
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * Drives the "who is talking" indicators.
   *
   * mediasoup measures levels on the server, so every participant sees the same
   * answer without decoding audio they are not listening to. This is what lets
   * someone confirm their microphone is reaching the room, which otherwise
   * takes asking out loud and interrupting whoever is working.
   *
   * Only browser producers are watched. The observer reads the
   * `ssrc-audio-level` RTP header extension, which browsers add and ffmpeg does
   * not, so adding the hardware feeds here would register producers that can
   * never report a level. Feed metering is done client-side instead, on the
   * audio the listener is already decoding.
   */
  const audioLevelObserver = await router.createAudioLevelObserver({
    maxEntries: 8,
    threshold: -55, // dBov; below this is treated as room noise, not speech
    interval: 400,
  });

  /** producerId -> { roomId, socketId }, for attributing observed levels. */
  const producerOwners = new Map();

  function watchLevels(producerId) {
    audioLevelObserver
      .addProducer({ producerId })
      .catch((error) => console.warn("audioLevelObserver:", error.message));
  }

  // The observer's event handlers are wired further down, once `io` and the
  // room registry they publish to exist.

  /** Producer ids belonging to hardware feeds, which every room may consume. */
  function feedProducerIds() {
    return new Set(
      capture.getFeeds().map((feed) => feed.producerId).filter(Boolean)
    );
  }

  // ------------------------------------------------------------ health check

  // Reports real subsystem state so Docker restarts a wedged container instead
  // of trusting a hardcoded "ok". Audio is reported but not fatal: browser-to-
  // browser intercom must keep working with the sound card unplugged.
  app.get("/api/health", async (req, res) => {
    const database = config.auth.bypass ? { ok: true } : await checkDatabase();
    const workerOk = !worker.closed;
    const healthy = database.ok && workerOk && !shuttingDown;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      database,
      mediasoup: { ok: workerOk, pid: worker.pid },
      audio: {
        capture: await capture.getStatus(),
        playback: playback.getStatus(),
      },
      rooms: [...rooms].map(([name, state]) => ({
        name,
        participants: state.peers.size,
      })),
      timestamp: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------ static files

  // Only the vendored browser bundle is exposed. The previous setup served all
  // of node_modules, publishing every dependency's source to any LAN client.
  app.use(
    "/vendor",
    express.static(path.join(__dirname, "public", "vendor"), {
      maxAge: "1h",
      fallthrough: false,
    })
  );
  app.use(express.static(path.join(__dirname, "public")));

  // ------------------------------------------------------------------ socket

  const io = new Server(server, {
    // Same-origin only. The previous `origin: "*"` combined with
    // `credentials: true` is both invalid and permissive.
    cors: { origin: false },
    // Survive brief Wi-Fi dropouts, which a phone in a church building will
    // hit constantly, without tearing down the peer's media state instantly.
    pingTimeout: 30000,
    pingInterval: 10000,
  });

  io.engine.use(sessionMiddleware);
  io.use(authenticateSocket);

  /** roomId -> { peers: { socketId: peerState } } */
  const rooms = new Map();

  function roomState(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, { peers: new Map() });
    return rooms.get(roomId);
  }

  function broadcastSpeaking(volumes) {
    const speakersByRoom = new Map();

    for (const { producer, volume } of volumes) {
      const owner = producerOwners.get(producer.id);
      if (!owner) continue;
      if (!speakersByRoom.has(owner.roomId)) speakersByRoom.set(owner.roomId, []);
      speakersByRoom.get(owner.roomId).push({ id: owner.socketId, volume });
    }

    // Every active room gets an update each tick, including an empty one, so
    // clients can clear indicators rather than leaving someone lit up forever.
    for (const roomId of rooms.keys()) {
      io.to(roomId).emit("speaking", speakersByRoom.get(roomId) || []);
    }
  }

  audioLevelObserver.on("volumes", broadcastSpeaking);
  audioLevelObserver.on("silence", () => broadcastSpeaking([]));

  io.on("connection", (socket) => {
    const requestedRoom = String(socket.handshake.query?.room || "").trim();

    if (!config.rooms.includes(requestedRoom)) {
      socket.emit("error", "Unknown room");
      socket.disconnect(true);
      return;
    }

    // The room is fixed at connection time and never read from later messages.
    // Every handler below uses this value, which is what stops a client from
    // producing into, or consuming from, a room it never joined.
    const room = requestedRoom;
    socket.data.room = room;
    socket.join(room);

    const state = roomState(room);
    state.peers.set(socket.id, {
      transports: new Map(),
      consumers: new Map(),
      producer: null,
      producerId: null,
      displayName: socket.data.displayName,
      isAdmin: socket.data.isAdmin,
    });

    console.log(
      `${socket.data.username} joined "${room}" (${state.peers.size} in room)`
    );

    const peer = () => state.peers.get(socket.id);

    socket.emit(
      "peers",
      [...state.peers.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, other]) => ({
          id,
          name: other.displayName,
          admin: other.isAdmin,
        }))
    );

    socket.emit("feeds", capture.getFeeds());
    socket.emit("playback-state", playback.getStatus());

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      name: socket.data.displayName,
      admin: socket.data.isAdmin,
    });

    // Signature must match every other handler here: the client's request()
    // helper always emits a payload before the ack, so binding the first
    // parameter to the callback silently captures the payload instead. With
    // optional chaining that failed invisibly -- no ack, no error -- and the
    // client hung in establishMedia() until its 30s watchdog gave up.
    socket.on("getRtpCapabilities", (_payload, callback) => {
      callback?.(router.rtpCapabilities);
    });

    socket.on("createTransport", async (_payload, callback) => {
      try {
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: config.announcedIp }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: config.rtp.initialAvailableBitrate,
        });

        if (config.rtp.maxIncomingBitrate > 0) {
          await transport
            .setMaxIncomingBitrate(config.rtp.maxIncomingBitrate)
            .catch((error) =>
              console.warn("setMaxIncomingBitrate failed:", error.message)
            );
        }

        peer()?.transports.set(transport.id, transport);

        callback?.({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        console.error("createTransport failed:", error.message);
        callback?.({ error: "Could not create transport" });
      }
    });

    socket.on("connectTransport", async ({ transportId, dtlsParameters }, callback) => {
      const transport = peer()?.transports.get(transportId);
      if (!transport) return callback?.({ error: "Unknown transport" });

      try {
        await transport.connect({ dtlsParameters });
        callback?.({ connected: true });
      } catch (error) {
        console.error("connectTransport failed:", error.message);
        callback?.({ error: "Could not connect transport" });
      }
    });

    socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
      const current = peer();
      const transport = current?.transports.get(transportId);
      if (!transport) return callback?.({ error: "Unknown transport" });

      if (kind !== "audio") {
        return callback?.({ error: "Only audio is supported" });
      }

      try {
        const producer = await transport.produce({ kind, rtpParameters });
        current.producer = producer;
        current.producerId = producer.id;

        producerOwners.set(producer.id, { roomId: room, socketId: socket.id });
        watchLevels(producer.id);

        producer.on("transportclose", () => producer.close());

        socket.to(room).emit("new-producer", {
          producerId: producer.id,
          socketId: socket.id,
        });

        callback?.({ id: producer.id });
      } catch (error) {
        console.error("produce failed:", error.message);
        callback?.({ error: "Could not start microphone stream" });
      }
    });

    socket.on("getProducers", (_payload, callback) => {
      const list = [];
      for (const [id, other] of state.peers) {
        if (id !== socket.id && other.producerId) {
          list.push({ producerId: other.producerId, socketId: id });
        }
      }
      callback?.(list);
    });

    socket.on("getFeeds", (_payload, callback) => {
      callback?.(capture.getFeeds());
    });

    socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, callback) => {
      const current = peer();
      const transport = current?.transports.get(transportId);
      if (!transport) return callback?.({ error: "Unknown transport" });

      // A client may only consume producers from its own room, or a hardware
      // feed. Without this check any producer id in the process is fair game.
      const inRoom = [...state.peers.values()].some(
        (other) => other.producerId === producerId
      );
      if (!inRoom && !feedProducerIds().has(producerId)) {
        return callback?.({ error: "Producer not available in this room" });
      }

      try {
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          return callback?.({ error: "Incompatible client" });
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        current.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          current.consumers.delete(consumer.id);
        });
        consumer.on("producerclose", () => {
          current.consumers.delete(consumer.id);
          socket.emit("producer-closed", { producerId });
        });

        callback?.({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        console.error("consume failed:", error.message);
        callback?.({ error: "Could not receive audio" });
      }
    });

    socket.on("resumeConsumer", async ({ consumerId }, callback) => {
      const consumer = peer()?.consumers.get(consumerId);
      if (!consumer) return callback?.({ error: "Unknown consumer" });

      try {
        await consumer.resume();
        callback?.({ resumed: true });
      } catch (error) {
        callback?.({ error: "Could not resume audio" });
      }
    });

    socket.on("closeConsumer", ({ consumerId }, callback) => {
      const consumer = peer()?.consumers.get(consumerId);
      if (consumer) {
        try { consumer.close(); } catch { /* already closed */ }
        peer()?.consumers.delete(consumerId);
      }
      callback?.({ closed: true });
    });

    socket.on("kick", ({ targetId }) => {
      if (!socket.data.isAdmin) return socket.emit("error", "Not authorized");

      const target = io.sockets.sockets.get(targetId);
      if (!target || target.data.room !== room) {
        return socket.emit("error", "That person is not in this room");
      }

      target.emit("kicked", { byName: socket.data.displayName });
      setTimeout(() => target.disconnect(true), 200);
    });

    socket.on("setPlayback", async ({ enabled }, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        return callback({ error: "Admin privileges required" });
      }

      try {
        if (enabled) {
          const producerId = peer()?.producerId;
          if (!producerId) {
            return callback({ error: "Your microphone is not active yet" });
          }
          await playback.start(socket.id, producerId);
        } else {
          await playback.stop(socket.id, "stopped by admin");
        }

        io.emit("playback-state", playback.getStatus());
        callback({ ok: true, enabled: !!enabled });
      } catch (error) {
        console.error("setPlayback failed:", error.message);
        callback({ error: error.message });
      }
    });

    socket.on("disconnecting", () => {
      const current = state.peers.get(socket.id);
      if (!current) return;

      playback.stop(socket.id, "peer disconnected").catch(() => {});

      if (current.producerId) {
        producerOwners.delete(current.producerId);
        socket.to(room).emit("producer-closed", { producerId: current.producerId });
      }

      for (const consumer of current.consumers.values()) {
        try { consumer.close(); } catch { /* already closed */ }
      }
      // Closing a transport closes its producers and consumers, so this covers
      // the producer too.
      for (const transport of current.transports.values()) {
        try { transport.close(); } catch { /* already closed */ }
      }

      state.peers.delete(socket.id);
      socket.to(room).emit("peer-left", { id: socket.id, name: current.displayName });

      if (state.peers.size === 0) rooms.delete(room);

      console.log(
        `${socket.data.username} left "${room}" (${state.peers.size} remaining)`
      );
    });
  });

  // ---------------------------------------------------------------- lifecycle

  await new Promise((resolve) => server.listen(config.port, resolve));

  const scheme = config.https.enabled ? "https" : "http";
  console.log(`\nChurch Intercom listening on ${scheme}://${config.announcedIp}:${config.port}`);
  if (config.announcedIpWasDetected) {
    console.log(`  (LAN address auto-detected; set ANNOUNCED_IP to override)`);
  }
  console.log(`  Rooms: ${config.rooms.join(", ")}`);
  const feeds = capture.getFeeds();
  console.log(
    `  Audio feeds: ${feeds.length ? feeds.map((f) => f.name).join(", ") : "none"}\n`
  );

  /**
   * Ordered teardown. Child processes first so ffmpeg releases the sound card,
   * then media, then the database. Without this, SIGTERM from `docker stop`
   * leaves orphaned ffmpeg processes holding the ALSA device, and the next
   * container start cannot open it.
   */
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting down (${reason})...`);

    const forceExit = setTimeout(() => {
      console.error("Shutdown timed out - forcing exit");
      process.exit(exitCode || 1);
    }, 10000);
    forceExit.unref();

    try {
      io.close();
      await new Promise((resolve) => server.close(resolve));
      await playback.stop(null, "server shutting down");
      await capture.stop();
      if (!worker.closed) worker.close();
      await closeDatabase();
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    }

    clearTimeout(forceExit);
    console.log("Shutdown complete");
    process.exit(exitCode);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A crash that leaves the process running half-dead is worse than a restart,
  // because Docker's restart policy can only help if we actually exit.
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    shutdown("uncaught-exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });
}

if (!config.auth.bypass) {
  await waitForDatabase();
  await bootstrapAdminUser();
}

await start();
