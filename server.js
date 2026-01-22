import express from "express";
import http from "http";
import https from "https";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { spawn } from "child_process";
import session from "express-session";
import cookieParser from "cookie-parser";
import pgSession from "connect-pg-simple";

// add these imports to compute __dirname in ESM and load environment files
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Import authentication functions
import {
  registerUser,
  loginUser,
  getUserById,
  requireAuth,
  requireAdmin,
  authenticateSocket,
} from "./auth.js";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function applyEnvFromFile(filename) {
  const filePath = path.join(__dirname, filename);
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const contents = fs.readFileSync(filePath, "utf8");
    contents.split(/\r?\n/).forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        return;
      }

      const exportPrefix = line.startsWith("export ") ? "export " : "";
      const normalizedLine = exportPrefix
        ? line.slice(exportPrefix.length)
        : line;
      const separatorIndex = normalizedLine.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = normalizedLine.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) {
        return;
      }

      let value = normalizedLine.slice(separatorIndex + 1);

      // Preserve spaces inside quoted values and support escaped newlines
      const trimmedValue = value.trim();
      if (
        (trimmedValue.startsWith("\"") && trimmedValue.endsWith("\"")) ||
        (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
      ) {
        value = trimmedValue.slice(1, -1);
      } else {
        // Remove inline comments for unquoted values
        value = trimmedValue.replace(/\s+#.*$/, "");
      }

      process.env[key] = value.replace(/\\n/g, "\n");
    });
  } catch (error) {
    console.warn(`Failed to load environment variables from ${filePath}:`, error);
  }
}

// Explicit precedence: real environment > .env > .env.default
applyEnvFromFile(".env");
applyEnvFromFile(".env.default");

async function start() {
  const app = express();
  const HTTPS_ENABLED = ["1", "true", "yes"].includes(
    (process.env.HTTPS || "").toLowerCase()
  );

  let server;
  if (HTTPS_ENABLED) {
    const keyPath = process.env.SSL_KEY_PATH;
    const certPath = process.env.SSL_CERT_PATH;
    const caPath = process.env.SSL_CA_PATH;

    if (!keyPath || !certPath) {
      console.error(
        "HTTPS is enabled but SSL_KEY_PATH and SSL_CERT_PATH environment variables are not both set."
      );
      process.exit(1);
    }

    try {
      const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };

      if (caPath) {
        httpsOptions.ca = fs.readFileSync(caPath);
      }

      server = https.createServer(httpsOptions, app);
      console.log("HTTPS server enabled");
    } catch (error) {
      console.error("Failed to read SSL certificate files:", error);
      process.exit(1);
    }
  } else {
    server = http.createServer(app);
  }

  // Middleware setup
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Session configuration
  const PgStore = pgSession(session);
  const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-in-production";

  if (SESSION_SECRET === "change-this-secret-in-production") {
    console.warn("WARNING: Using default session secret. Set SESSION_SECRET environment variable in production!");
  }

  // Use memory store when BYPASS_AUTH is enabled (for local testing without database)
  const sessionConfig = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,  // Allow cookies over HTTPS with self-signed certs
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: "lax",  // Changed from strict to lax for better compatibility
    },
  };

  if (process.env.BYPASS_AUTH === 'true') {
    console.log('BYPASS_AUTH enabled - using memory session store instead of PostgreSQL');
    // MemoryStore is the default, no need to specify
  } else {
    sessionConfig.store = new PgStore({
      pool,
      tableName: "sessions",
      createTableIfMissing: true,
    });
  }

  const sessionMiddleware = session(sessionConfig);

  app.use(sessionMiddleware);

  const io = new Server(server, {
    cors: {
      origin: HTTPS_ENABLED ? false : "*",
      credentials: true,
    },
  });

  // Share session with Socket.IO
  io.engine.use(sessionMiddleware);

  const PORT = process.env.PORT || 3000;
  const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "127.0.0.1"; // change to your public/LAN IP
  console.log(`Using ANNOUNCED_IP: ${ANNOUNCED_IP}`);
  const MAX_INCOMING_BITRATE = parseInt(process.env.MAX_INCOMING_BITRATE || "800000", 10);
  const INITIAL_AVAILABLE_BITRATE = parseInt(process.env.INITIAL_AVAILABLE_BITRATE || "1000000", 10);

  // Authentication Routes
  app.post("/api/register", async (req, res) => {
    try {
      const { username, email, password, displayName } = req.body;

      if (!username || !email || !password || !displayName) {
        return res.status(400).json({ error: "All fields are required" });
      }

      const user = await registerUser(username, email, password, displayName, false);

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.displayName = user.display_name;
      req.session.isAdmin = user.is_admin;

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          isAdmin: user.is_admin,
        },
      });
    } catch (error) {
      console.error("Registration error:", error.message);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/login", async (req, res) => {
    try {
      const { usernameOrEmail } = req.body;

      if (!usernameOrEmail) {
        return res.status(400).json({ error: "Username is required" });
      }

      // Login without password - just use username
      const user = await loginUser(usernameOrEmail, "dummy");

      // Handle both camelCase and snake_case from auth module
      const displayName = user.displayName || user.display_name;
      const isAdmin = user.isAdmin !== undefined ? user.isAdmin : user.is_admin;

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.displayName = displayName;
      req.session.isAdmin = isAdmin;

      // Explicitly save session before responding
      req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err);
          return res.status(500).json({ error: 'Session save failed' });
        }
        res.json({
          success: true,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            displayName: displayName,
            isAdmin: isAdmin,
          },
        });
      });
    } catch (error) {
      console.error("Login error:", error.message);
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ error: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  app.get("/api/user", requireAuth, async (req, res) => {
    try {
      const user = await getUserById(req.session.userId, req.session);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
      });
    } catch (error) {
      console.error("Get user error:", error.message);
      res.status(500).json({ error: "Failed to get user information" });
    }
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Config: 8 rooms with custom names for the first three and defaults for the rest
  const DEFAULT_ROOMS = Array.from({ length: 5 }, (_, i) => `room${i + 4}`);
  const ROOMS = [
    "Video Production",
    "media",
    "bashkepunetoret",
    ...DEFAULT_ROOMS,
  ];

  // Serve node_modules for ES modules (mediasoup-client and dependencies)
  app.use("/node_modules", express.static(path.join(__dirname, "node_modules")));
  console.log("Serving node_modules for ES module imports");

  // Serve static client
  app.use(express.static("public"));

  // Mediasoup worker
  const worker = await mediasoup.createWorker();
  worker.on("died", () => {
    console.error("Mediasoup worker died, exiting...");
    process.exit(1);
  });

  // Audio-only rooms (Opus)
  const mediaCodecs = [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  ];
  const router = await worker.createRouter({ mediaCodecs });

  // Rooms { roomId: { peers: { socketId: { transports: {...}, producer, consumers: {}, serverFeed: {...} } } } }
  const rooms = {};

  function ensureRoomState(roomId) {
    if (!rooms[roomId]) {
      rooms[roomId] = { peers: {} };
    }
    return rooms[roomId];
  }

  const SERVER_FEED_NAME = process.env.SERVER_AUDIO_NAME || "House Feed";
  const SERVER_FEED_PREFIX = "server-feed:";
  const SERVER_FEED_COMMAND = process.env.SERVER_AUDIO_COMMAND || "";
  const SERVER_FEED_PAYLOAD_TYPE = parseInt(process.env.SERVER_AUDIO_PAYLOAD_TYPE || "100", 10);

  // Admin-to-server audio streaming configuration
  const ADMIN_TO_SERVER_COMMAND = process.env.ADMIN_TO_SERVER_COMMAND || "";

  function getServerFeedId(socketId) {
    return `${SERVER_FEED_PREFIX}${socketId}`;
  }

  function tokenizeCommand(command) {
    const tokens = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";
    for (let i = 0; i < command.length; i += 1) {
      const char = command[i];
      if (inQuotes) {
        if (char === quoteChar) {
          inQuotes = false;
        } else if (char === "\\" && command[i + 1] === quoteChar) {
          current += quoteChar;
          i += 1;
        } else {
          current += char;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        inQuotes = true;
        quoteChar = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }

      if (char === "\\" && i + 1 < command.length) {
        const next = command[i + 1];
        current += next;
        i += 1;
        continue;
      }

      current += char;
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  async function stopServerFeed(socketId, { skipProcessKill = false, reason = "stopped" } = {}) {
    // Find the peer that owns this server feed
    let peer = null;
    let roomId = null;

    for (const [rId, roomState] of Object.entries(rooms)) {
      if (roomState.peers[socketId]?.serverFeed) {
        peer = roomState.peers[socketId];
        roomId = rId;
        break;
      }
    }

    const feed = peer?.serverFeed;
    if (!feed) {
      return;
    }

    peer.serverFeed = null;

    // Stop recording if using native audio input
    if (feed.recording) {
      try {
        feed.recording.stop();
      } catch (err) {
        console.warn("Failed to stop audio recording", err.message);
      }
    }

    // Close UDP socket if exists and not already closed
    if (feed.udpSocket) {
      try {
        // Check if socket is still open before closing
        if (feed.udpSocket._handle) {
          feed.udpSocket.close();
        }
      } catch (err) {
        // Ignore - socket may already be closed
      }
    }

    // Kill sox/ffmpeg process
    if (feed.child && !skipProcessKill) {
      try {
        feed.child.kill("SIGTERM");
      } catch (err) {
        console.warn("Failed to kill audio process", err.message);
      }
    }

    if (feed.producer) {
      try {
        feed.producer.close();
      } catch (err) {
        console.warn("Failed to close server producer", err.message);
      }
    }

    if (feed.transport) {
      try {
        feed.transport.close();
      } catch (err) {
        console.warn("Failed to close server transport", err.message);
      }
    }

    // Notify only the user who had the server feed
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit("server-feed-state", {
        enabled: false,
        id: feed.feedId,
        reason,
      });
      targetSocket.emit("producer-closed", { producerId: feed.producerId });
    }
  }

  async function startServerFeed(socketId, roomId) {
    const roomState = ensureRoomState(roomId);
    const peer = roomState.peers[socketId];
    if (!peer) {
      throw new Error("Peer not found");
    }

    // Check if this user already has a server feed
    if (peer.serverFeed?.producer) {
      return peer.serverFeed;
    }

    // Create PlainTransport for receiving RTP from sox/ffmpeg
    const transport = await router.createPlainTransport({
      listenIp: { ip: "127.0.0.1" },
      enableUdp: true,
      enableTcp: false,
      rtcpMux: true,
      comedia: true, // Let sox send first, mediasoup will respond
    });

    const codec = router.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === "audio/opus"
    );
    if (!codec) {
      await transport.close();
      throw new Error("Router does not support Opus audio");
    }

    const ssrc = Math.floor(Math.random() * 0xffffffff);
    const payloadType = 100;

    // Create producer with opus codec
    const producer = await transport.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{
          mimeType: 'audio/opus',
          payloadType,
          clockRate: 48000,
          channels: 2,
          parameters: {
            useinbandfec: 1,
            stereo: 1,
          },
        }],
        encodings: [{ ssrc }],
      },
    });

    const feedId = getServerFeedId(socketId);
    const name = SERVER_FEED_NAME;
    const port = transport.tuple.localPort;

    console.log(`Starting house feed audio capture for user ${socketId} on port ${port}`);

    // Use sox to capture audio and send as RTP to mediasoup
    // sox captures from default input, encodes to opus, sends via RTP
    const child = spawn('sox', [
      '-d',                    // Default audio input device
      '-t', 'raw',             // Output raw PCM
      '-r', '48000',           // Sample rate
      '-c', '2',               // Stereo
      '-b', '16',              // 16-bit
      '-e', 'signed-integer',  // Signed PCM
      '-',                     // Output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Import opus encoder
    const opusModule = await import('@discordjs/opus');
    const OpusEncoder = opusModule.default?.OpusEncoder || opusModule.OpusEncoder;
    const opusEncoder = new OpusEncoder(48000, 2);

    // Create UDP socket to send RTP to mediasoup
    const dgram = await import('dgram');
    const udpSocket = dgram.createSocket('udp4');

    let sequenceNumber = 0;
    let timestamp = 0;
    const frameSize = 960; // 20ms at 48kHz
    const bytesPerFrame = frameSize * 2 * 2; // 16-bit stereo
    let pcmBuffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk) => {
      pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

      while (pcmBuffer.length >= bytesPerFrame) {
        const frame = pcmBuffer.subarray(0, bytesPerFrame);
        pcmBuffer = pcmBuffer.subarray(bytesPerFrame);

        try {
          // Encode PCM to opus
          const opusPacket = opusEncoder.encode(frame);

          // Create RTP packet
          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = 0x80; // Version 2
          rtpHeader[1] = payloadType;
          rtpHeader.writeUInt16BE(sequenceNumber % 65536, 2);
          rtpHeader.writeUInt32BE(timestamp % 0xffffffff, 4);
          rtpHeader.writeUInt32BE(ssrc, 8);

          const rtpPacket = Buffer.concat([rtpHeader, opusPacket]);

          // Send RTP to mediasoup PlainTransport
          udpSocket.send(rtpPacket, port, '127.0.0.1');

          sequenceNumber++;
          timestamp += frameSize;
        } catch (err) {
          // Ignore encode errors
        }
      }
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('WARN')) {
        console.log(`[House feed sox]: ${msg}`);
      }
    });

    child.on('error', (err) => {
      console.error('House feed process error:', err);
      stopServerFeed(socketId, { reason: `process-error:${err.message}` }).catch(() => {});
    });

    child.on('exit', (code, signal) => {
      console.log(`House feed process exited: code=${code}, signal=${signal}`);
      if (roomState.peers[socketId]?.serverFeed?.child === child) {
        stopServerFeed(socketId, { skipProcessKill: true, reason: `process-exit:${code}` }).catch(() => {});
      }
    });

    const feed = {
      transport,
      producer,
      child,
      udpSocket,
      opusEncoder,
      feedId,
      name,
      producerId: producer.id,
    };
    peer.serverFeed = feed;

    producer.on("transportclose", () => {
      stopServerFeed(socketId, { skipProcessKill: true, reason: "transport-close" }).catch(() => {});
    });

    producer.on("close", () => {
      stopServerFeed(socketId, { skipProcessKill: true, reason: "producer-close" }).catch(() => {});
    });

    // Notify only the requesting user
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit("server-feed-state", { enabled: true, id: feedId, name });
      targetSocket.emit("new-producer", {
        producerId: producer.id,
        socketId: feedId,
        serverFeed: true,
        name,
      });
    }

    console.log(`House feed started for ${socketId}`);
    return feed;
  }

  /**
   * Stop admin-to-server audio streaming for a specific socket
   * @param {string} socketId - The socket ID of the admin
   * @param {object} options - Options for stopping
   * @param {boolean} options.skipProcessKill - Skip killing the FFmpeg process
   * @param {string} options.reason - Reason for stopping
   */
  async function stopAdminToServer(socketId, { skipProcessKill = false, reason = "stopped" } = {}) {
    // Find the peer that owns this admin-to-server stream
    let peer = null;
    let roomId = null;

    for (const [rId, roomState] of Object.entries(rooms)) {
      if (roomState.peers[socketId]?.adminToServer) {
        peer = roomState.peers[socketId];
        roomId = rId;
        break;
      }
    }

    const stream = peer?.adminToServer;
    if (!stream) {
      return;
    }

    peer.adminToServer = null;

    // Kill ffplay process
    if (stream.child && !skipProcessKill) {
      try {
        stream.child.kill("SIGTERM");
      } catch (err) {
        console.warn("Failed to kill admin-to-server ffplay process", err.message);
      }
    }

    // Clean up SDP file
    if (stream.sdpPath) {
      try {
        const fsMod = await import('fs');
        fsMod.unlinkSync(stream.sdpPath);
      } catch (err) {
        // Ignore - file may already be deleted
      }
    }

    // Close consumer
    if (stream.consumer) {
      try {
        stream.consumer.close();
      } catch (err) {
        console.warn("Failed to close admin-to-server consumer", err.message);
      }
    }

    // Close transport
    if (stream.transport) {
      try {
        stream.transport.close();
      } catch (err) {
        console.warn("Failed to close admin-to-server transport", err.message);
      }
    }

    // Notify the admin user
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit("admin-to-server-state", {
        enabled: false,
        reason,
      });
    }

    console.log(`Admin-to-server streaming stopped for ${socketId}: ${reason}`);
  }

  /**
   * Start admin-to-server audio streaming for a specific admin
   * Uses DirectTransport with speaker package for native audio output
   * @param {string} socketId - The socket ID of the admin
   * @param {string} roomId - The room ID
   * @param {string} producerId - The producer ID from the admin's audio
   * @param {object} rtpCapabilities - RTP capabilities from the admin (unused, kept for API compatibility)
   */
  async function startAdminToServer(socketId, roomId, producerId, rtpCapabilities) {
    const roomState = ensureRoomState(roomId);
    const peer = roomState.peers[socketId];
    if (!peer) {
      throw new Error("Peer not found");
    }

    // Check if this user already has an admin-to-server stream
    if (peer.adminToServer?.consumer) {
      return peer.adminToServer;
    }

    // Use router's RTP capabilities for DirectTransport
    const routerRtpCapabilities = router.rtpCapabilities;

    // Try provided producerId first, fall back to peer's current producer
    let activeProducerId = producerId;
    if (!router.canConsume({ producerId: activeProducerId, rtpCapabilities: routerRtpCapabilities })) {
      // Try the peer's current producer
      if (peer.producerId && router.canConsume({ producerId: peer.producerId, rtpCapabilities: routerRtpCapabilities })) {
        activeProducerId = peer.producerId;
        console.log(`Admin-to-server: Using peer's current producer ${activeProducerId} instead of ${producerId}`);
      } else {
        throw new Error("Cannot consume producer - producer may not exist or be closed");
      }
    }

    // Update producerId for the rest of the function
    producerId = activeProducerId;

    // Create PlainTransport for consuming audio - mediasoup will send RTP to ffplay
    const transport = await router.createPlainTransport({
      listenIp: { ip: "127.0.0.1" },
      enableUdp: true,
      enableTcp: false,
      rtcpMux: true,
      comedia: false, // We specify where to send
    });

    // Create consumer first to get RTP parameters
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: routerRtpCapabilities,
      paused: true, // Start paused until ffplay is ready
    });

    // Get codec info from consumer
    const codec = consumer.rtpParameters.codecs[0];
    const payloadType = codec.payloadType;
    const clockRate = codec.clockRate;
    const channels = codec.channels || 2;

    // Pick a port for ffplay to listen on
    const ffplayPort = 30000 + Math.floor(Math.random() * 10000);

    // Create SDP file for ffplay
    const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Admin Audio Stream
c=IN IP4 127.0.0.1
t=0 0
m=audio ${ffplayPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} opus/${clockRate}/${channels}
a=fmtp:${payloadType} minptime=10;useinbandfec=1
a=recvonly
`;

    // Write SDP to temp file
    const os = await import('os');
    const pathMod = await import('path');
    const fsMod = await import('fs');
    const sdpPath = pathMod.join(os.tmpdir(), `admin-audio-${socketId}-${Date.now()}.sdp`);
    fsMod.writeFileSync(sdpPath, sdpContent);

    console.log(`Admin-to-server: Created SDP at ${sdpPath} for port ${ffplayPort}`);

    // Start ffplay to receive and play the RTP stream
    const child = spawn('ffplay', [
      '-nodisp',           // No video display
      '-autoexit',         // Exit when stream ends
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,rtp,udp',
      '-i', sdpPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data) => {
      console.log(`[Admin-to-server ffplay]: ${data.toString().trim()}`);
    });

    child.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('Last message repeated')) {
        console.log(`[Admin-to-server ffplay]: ${msg}`);
      }
    });

    // Give ffplay time to start and bind to port
    await new Promise(resolve => setTimeout(resolve, 500));

    // Connect transport to ffplay's port
    await transport.connect({
      ip: '127.0.0.1',
      port: ffplayPort,
    });

    // Resume consumer now that ffplay is ready
    await consumer.resume();

    console.log(`Admin-to-server: Streaming to ffplay for ${socketId}`);

    child.on('error', (err) => {
      console.error('ffplay error:', err);
      stopAdminToServer(socketId, { reason: `ffplay-error:${err.message}` }).catch(() => {});
    });

    child.on('exit', (code, signal) => {
      console.log(`Admin-to-server ffplay exited: code=${code}, signal=${signal}`);
      // Clean up SDP file
      try { fsMod.unlinkSync(sdpPath); } catch (e) {}
      if (roomState.peers[socketId]?.adminToServer?.child === child) {
        stopAdminToServer(socketId, { skipProcessKill: true, reason: `ffplay-exit:${code}` }).catch(() => {});
      }
    });

    const stream = {
      transport,
      consumer,
      child,
      sdpPath,
      consumerId: consumer.id,
    };
    peer.adminToServer = stream;

    consumer.on("transportclose", () => {
      stopAdminToServer(socketId, { reason: "transport-close" }).catch(() => {});
    });

    consumer.on("producerclose", () => {
      stopAdminToServer(socketId, { reason: "producer-close" }).catch(() => {});
    });

    // Notify the admin user
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit("admin-to-server-state", { enabled: true });
    }

    console.log(`Admin-to-server streaming started for ${socketId}`);
    return stream;
  }

  // Socket.IO authentication middleware
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id, "User:", socket.data.username);

    // Get room from handshake query
    const qs = socket.handshake.query || {};
    const rawRoom = Array.isArray(qs.room) ? qs.room[0] : qs.room;
    const room = typeof rawRoom === "string" ? rawRoom.trim() : "";

    if (!room || !ROOMS.includes(room)) {
      socket.emit("error", "missing or invalid room");
      socket.disconnect(true);
      return;
    }

    // User info already set by authenticateSocket middleware
    socket.data.room = room;

    socket.join(room);

    const roomState = ensureRoomState(room);

    // collect existing peers in room
    const peers = Array.from(io.sockets.adapter.rooms.get(room) || []);
    const otherPeers = peers.filter((id) => id !== socket.id);

    // send existing peers to joining client
    const peerSummaries = otherPeers.map((id) => {
      const peerSocket = io.sockets.sockets.get(id);
      return {
        id,
        admin: !!peerSocket?.data?.isAdmin,
        name: peerSocket?.data?.displayName || "",
      };
    });

    if (roomState.serverFeed?.producer) {
      peerSummaries.push({
        id: roomState.serverFeed.feedId,
        admin: false,
        name: roomState.serverFeed.name,
        serverFeed: true,
      });
      socket.emit("server-feed-state", {
        roomId: room,
        enabled: true,
        id: roomState.serverFeed.feedId,
        name: roomState.serverFeed.name,
      });
      socket.emit("new-producer", {
        producerId: roomState.serverFeed.producerId,
        socketId: roomState.serverFeed.feedId,
        serverFeed: true,
        name: roomState.serverFeed.name,
      });
    } else {
      socket.emit("server-feed-state", {
        roomId: room,
        enabled: false,
        id: getServerFeedId(room),
        name: SERVER_FEED_NAME,
      });
    }

    socket.emit("peers", peerSummaries);

    // notify others
    socket
      .to(room)
      .emit("peer-joined", {
        id: socket.id,
        admin: socket.data.isAdmin,
        name: socket.data.displayName,
      });

    // basic signaling for non-mediasoup fallback (kept for compatibility)
    socket.on("signal", (msg) => {
      const { to, data } = msg || {};
      if (!to) return;
      const target = io.sockets.sockets.get(to);
      if (target) target.emit("signal", { from: socket.id, data });
    });

    // admin kick
    socket.on("kick", ({ targetId }) => {
      if (!socket.data.isAdmin) {
        socket.emit("error", "not authorized");
        return;
      }
      const target = io.sockets.sockets.get(targetId);
      if (!target || target.data.room !== room) {
        socket.emit("error", "target not found in room");
        return;
      }
      target.emit("kicked", { by: socket.id, byName: socket.data.displayName });
      setTimeout(() => target.disconnect(true), 200);
    });

    // Ensure room bookkeeping
    socket.on("joinRoom", async ({ roomId }, callback) => {
      const roomStateLocal = ensureRoomState(roomId);
      roomStateLocal.peers[socket.id] =
        roomStateLocal.peers[socket.id] || {
          transports: {},
          consumers: {},
        };
      roomStateLocal.peers[socket.id].name = socket.data.displayName;
      roomStateLocal.peers[socket.id].isAdmin = socket.data.isAdmin;
      callback && callback({ joined: true });
    });

    // return router rtpCapabilities
    socket.on("getRtpCapabilities", (callback) => {
      callback && callback(router.rtpCapabilities);
    });

    // create transport
    socket.on("createTransport", async ({ roomId }, callback) => {
      const roomStateLocal = ensureRoomState(roomId);
      roomStateLocal.peers[socket.id] =
        roomStateLocal.peers[socket.id] || { transports: {}, consumers: {} };

      try {
        console.log(`Creating WebRTC transport with announcedIp: ${ANNOUNCED_IP}`);
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: INITIAL_AVAILABLE_BITRATE,
          portRange: { min: 40000, max: 40100 },
        });

        if (!Number.isNaN(MAX_INCOMING_BITRATE) && MAX_INCOMING_BITRATE > 0) {
          try {
            await transport.setMaxIncomingBitrate(MAX_INCOMING_BITRATE);
          } catch (err) {
            console.warn("setMaxIncomingBitrate failed", err.message);
          }
        }

        roomStateLocal.peers[socket.id].transports[transport.id] = transport;

        callback &&
          callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          });
      } catch (err) {
        console.error("createTransport error:", err);
        callback && callback({ error: err.message });
      }
    });

    // connect transport by id
    socket.on("connectTransport", async ({ roomId, transportId, dtlsParameters }, callback) => {
      const transport = rooms[roomId]?.peers[socket.id]?.transports?.[transportId];
      if (!transport) {
        callback && callback({ error: "transport not found" });
        return;
      }
      try {
        console.log(`Connecting transport ${transportId} for ${socket.id}`);
        await transport.connect({ dtlsParameters });
        console.log(`Transport ${transportId} connected - state:`, {
          iceState: transport.iceState,
          iceSelectedTuple: transport.iceSelectedTuple,
          dtlsState: transport.dtlsState
        });
        callback && callback({ connected: true });
      } catch (err) {
        console.error("connectTransport error:", err);
        callback && callback({ error: err.message });
      }
    });

    // produce and notify others
    socket.on("produce", async ({ roomId, transportId, kind, rtpParameters }, callback) => {
      try {
        const transport = rooms[roomId]?.peers[socket.id]?.transports?.[transportId];
        if (!transport) return callback && callback({ error: "transport not found" });
        const producer = await transport.produce({ kind, rtpParameters });
        console.log(`Producer created on server for ${socket.id}:`, {
          producerId: producer.id,
          kind: producer.kind,
          paused: producer.paused,
          score: producer.score
        });
        const roomStateLocal = ensureRoomState(roomId);
        roomStateLocal.peers[socket.id].producer = producer;
        roomStateLocal.peers[socket.id].producerId = producer.id;

        // notify other peers in the room about the new producer
        socket.to(roomId).emit("new-producer", { producerId: producer.id, socketId: socket.id });

        producer.on("transportclose", () => {
          producer.close();
        });
        producer.on("close", () => {
          socket.to(roomId).emit("producer-closed", { producerId: producer.id });
        });

        callback && callback({ id: producer.id });
      } catch (err) {
        console.error("produce error:", err);
        callback && callback({ error: err.message });
      }
    });

    // list current producers in the room (excluding requester, but including their server feed if active)
    socket.on("getProducers", ({ roomId }, callback) => {
      const list = [];
      const roomStateLocal = rooms[roomId];
      const peers = roomStateLocal?.peers || {};
      for (const [id, p] of Object.entries(peers)) {
        if (p.producerId && id !== socket.id) {
          list.push({ producerId: p.producerId, socketId: id });
        }
      }

      // Add this user's server feed producer if active
      const myPeer = peers[socket.id];
      if (myPeer?.serverFeed?.producerId) {
        list.push({
          producerId: myPeer.serverFeed.producerId,
          socketId: myPeer.serverFeed.feedId,
          serverFeed: true,
        });
      }

      callback && callback(list);
    });

    // consume: create server-side consumer and return params to client
    socket.on("consume", async ({ roomId, producerId, rtpCapabilities, transportId }, callback) => {
      try {
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          return callback && callback({ error: "cannotConsume" });
        }
        const transport = rooms[roomId]?.peers[socket.id]?.transports?.[transportId];
        if (!transport) return callback && callback({ error: "transport not found" });

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,  // Start paused, will be resumed by client
        });

        console.log(`Consumer created on server for ${socket.id}:`, {
          consumerId: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          paused: consumer.paused,
          producerPaused: consumer.producerPaused
        });

        const roomStateLocal = ensureRoomState(roomId);
        roomStateLocal.peers[socket.id].consumers[consumer.id] = consumer;

        consumer.on("transportclose", () => {
          consumer.close();
        });
        consumer.on("producerclose", () => {
          // notify client that the producer closed
          socket.emit("producer-closed", { producerId });
        });

        callback &&
          callback({
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          });
      } catch (err) {
        console.error("consume error:", err);
        callback && callback({ error: err.message });
      }
    });

    // Resume consumer
    socket.on("resumeConsumer", async ({ roomId, consumerId }, callback) => {
      try {
        const consumer = rooms[roomId]?.peers[socket.id]?.consumers?.[consumerId];
        if (!consumer) {
          return callback && callback({ error: "consumer not found" });
        }
        console.log(`Resuming consumer ${consumerId} - before:`, {
          paused: consumer.paused,
          producerPaused: consumer.producerPaused
        });
        await consumer.resume();
        console.log(`Resumed consumer ${consumerId} - after:`, {
          paused: consumer.paused,
          producerPaused: consumer.producerPaused
        });
        callback && callback({ resumed: true });
      } catch (err) {
        console.error("resumeConsumer error:", err);
        callback && callback({ error: err.message });
      }
    });

    const cleanupPeer = () => {
      if (socket.data.__cleaned) {
        return;
      }
      socket.data.__cleaned = true;

      const joinedRoom = socket.data.room;
      console.log(`Cleaning up peer ${socket.id} (${socket.data.username}) from room ${joinedRoom}`);

      for (const [roomId, roomObj] of Object.entries(rooms)) {
        const peer = roomObj.peers[socket.id];
        if (!peer) continue;

        // Clean up user's server feed if active
        if (peer.serverFeed) {
          stopServerFeed(socket.id).catch((err) =>
            console.error(`Failed to stop server feed for peer ${socket.id}:`, err.message)
          );
        }

        // Clean up admin-to-server stream if active
        if (peer.adminToServer) {
          stopAdminToServer(socket.id).catch((err) =>
            console.error(`Failed to stop admin-to-server for peer ${socket.id}:`, err.message)
          );
        }

        if (peer.producer) {
          try {
            peer.producer.close();
          } catch (e) {
            console.error(`Error closing producer for peer ${socket.id}:`, e.message);
          }
          socket
            .to(roomId)
            .emit("producer-closed", { producerId: peer.producerId });
        }

        if (peer.consumers) {
          for (const c of Object.values(peer.consumers)) {
            try {
              c.close();
            } catch (e) {
              console.error(`Error closing consumer for peer ${socket.id}:`, e.message);
            }
          }
        }

        if (peer.transports) {
          for (const t of Object.values(peer.transports)) {
            try {
              t.close();
            } catch (e) {
              console.error(`Error closing transport for peer ${socket.id}:`, e.message);
            }
          }
        }

        delete roomObj.peers[socket.id];
        console.log(`Peer ${socket.id} (${socket.data.username}) left room ${roomId}`);

        if (Object.keys(roomObj.peers).length === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} is now empty and has been removed`);
        }
      }

      if (joinedRoom) {
        socket.to(joinedRoom).emit("peer-left", {
          id: socket.id,
          name: socket.data.displayName,
        });
        try {
          socket.leave(joinedRoom);
        } catch (e) {
          console.error(`Error leaving room ${joinedRoom}:`, e.message);
        }
      }
    };

    // Only use disconnecting event to avoid race condition
    socket.on("disconnecting", cleanupPeer);

    socket.on("setServerFeed", async ({ enabled }, callback = () => {}) => {
      const roomId = socket.data.room;
      if (!roomId) {
        callback({ error: "not in a room" });
        return;
      }

      try {
        if (enabled) {
          await startServerFeed(socket.id, roomId);
        } else {
          await stopServerFeed(socket.id);
        }
        callback({ ok: true, enabled: !!enabled });
      } catch (err) {
        console.error("setServerFeed error", err);
        callback({ error: err.message || "failed" });
      }
    });

    socket.on("setAdminToServer", async ({ enabled, producerId, rtpCapabilities }, callback = () => {}) => {
      // Only admins can use this feature
      if (!socket.data.isAdmin) {
        callback({ error: "Admin privileges required" });
        return;
      }

      const roomId = socket.data.room;
      if (!roomId) {
        callback({ error: "not in a room" });
        return;
      }

      try {
        if (enabled) {
          if (!producerId || !rtpCapabilities) {
            callback({ error: "producerId and rtpCapabilities required" });
            return;
          }
          await startAdminToServer(socket.id, roomId, producerId, rtpCapabilities);
        } else {
          await stopAdminToServer(socket.id);
        }
        callback({ ok: true, enabled: !!enabled });
      } catch (err) {
        console.error("setAdminToServer error", err);
        callback({ error: err.message || "failed" });
      }
    });
  });

  server.listen(PORT, () => {
    const protocol = HTTPS_ENABLED ? "https" : "http";
    console.log(`Server running on ${protocol}://localhost:${PORT}`);
    console.log(`Rooms: ${ROOMS.join(", ")}`);
  });
}

start();
