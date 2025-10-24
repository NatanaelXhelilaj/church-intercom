import express from "express";
import http from "http";
import https from "https";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { spawn } from "child_process";

// add these imports to compute __dirname in ESM and load environment files
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

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
  const io = new Server(server);

  const PORT = process.env.PORT || 3000;
  const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "127.0.0.1"; // change to your public/LAN IP
  const MAX_INCOMING_BITRATE = parseInt(process.env.MAX_INCOMING_BITRATE || "800000", 10);
  const INITIAL_AVAILABLE_BITRATE = parseInt(process.env.INITIAL_AVAILABLE_BITRATE || "1000000", 10);

  // Config: 8 rooms with custom names for the first three and defaults for the rest
  const DEFAULT_ROOMS = Array.from({ length: 5 }, (_, i) => `room${i + 4}`);
  const ROOMS = [
    "Video Production",
    "media",
    "bashkepunetoret",
    ...DEFAULT_ROOMS,
  ];

  // Serve a vendor copy of mediasoup-client if available
  // Try common locations and expose the first existing file at /vendor/mediasoup-client.js
  const candidates = [
    path.join(__dirname, "node_modules", "mediasoup-client", "lib", "mediasoup-client.es.js"),
    path.join(__dirname, "node_modules", "mediasoup-client", "lib", "mediasoup-client.js"),
    path.join(__dirname, "node_modules", "mediasoup-client", "lib", "index.mjs"),
    path.join(__dirname, "node_modules", "mediasoup-client", "dist", "mediasoup-client.es.js"),
    path.join(__dirname, "node_modules", "mediasoup-client", "dist", "mediasoup-client.js"),
    path.join(__dirname, "node_modules", "mediasoup-client", "dist", "mediasoup-client.min.js"),
    path.join(__dirname, "node_modules", "mediasoup-client", "lib", "mediasoup-client.min.js"),
  ];
  const vendorFile = candidates.find((p) => fs.existsSync(p));
  if (vendorFile) {
    const vendorRoutes = [
      "/vendor/mediasoup-client.js",
      "/vendor/mediasoup-client.mjs",
      "/vendor/mediasoup-client.min.js",
    ];
    vendorRoutes.forEach((route) => {
      app.get(route, (req, res) => {
        res.sendFile(vendorFile);
      });
    });
    console.log("Serving mediasoup-client from:", vendorFile);
  } else {
    console.warn("mediasoup-client vendor file not found. Run `npm install mediasoup-client` or adjust paths.");
  }

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

  // Rooms { roomId: { peers: { socketId: { transports: {...}, producer, consumers: {} } } } }
  const rooms = {};

  function ensureRoomState(roomId) {
    if (!rooms[roomId]) {
      rooms[roomId] = { peers: {}, serverFeed: null };
    }
    return rooms[roomId];
  }

  const SERVER_FEED_NAME = process.env.SERVER_AUDIO_NAME || "House Feed";
  const SERVER_FEED_PREFIX = "server-feed:";
  const SERVER_FEED_COMMAND = process.env.SERVER_AUDIO_COMMAND || "";
  const SERVER_FEED_PAYLOAD_TYPE = parseInt(process.env.SERVER_AUDIO_PAYLOAD_TYPE || "100", 10);

  function getServerFeedId(roomId) {
    return `${SERVER_FEED_PREFIX}${roomId}`;
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

  async function stopServerFeed(roomId, { skipProcessKill = false, reason = "stopped" } = {}) {
    const roomState = rooms[roomId];
    const feed = roomState?.serverFeed;
    if (!feed) {
      return;
    }

    roomState.serverFeed = null;

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

    io.to(roomId).emit("server-feed-state", {
      roomId,
      enabled: false,
      id: feed.feedId,
      reason,
    });

    io.to(roomId).emit("producer-closed", { producerId: feed.producerId });
    io.to(roomId).emit("peer-left", { id: feed.feedId, name: feed.name });

    if (roomState && Object.keys(roomState.peers || {}).length === 0) {
      delete rooms[roomId];
    }
  }

  async function startServerFeed(roomId) {
    const roomState = ensureRoomState(roomId);
    if (roomState.serverFeed?.producer) {
      return roomState.serverFeed;
    }

    if (!SERVER_FEED_COMMAND) {
      throw new Error("SERVER_AUDIO_COMMAND is not configured on the server");
    }

    const transport = await router.createPlainTransport({
      listenIp: { ip: "0.0.0.0", announcedIp: ANNOUNCED_IP },
      enableUdp: true,
      enableTcp: false,
      comedia: true,
      rtcpMux: true,
    });

    const codec = router.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === "audio/opus"
    );
    if (!codec) {
      await transport.close();
      throw new Error("Router does not support Opus audio");
    }

    const ssrc = Math.floor(Math.random() * 0xffffffff);
    const payloadType = Number.isFinite(SERVER_FEED_PAYLOAD_TYPE)
      ? SERVER_FEED_PAYLOAD_TYPE
      : 100;
    const cname = `${getServerFeedId(roomId)}-${Date.now()}`;
    const rtpParameters = {
      mid: "0",
      codecs: [
        {
          mimeType: codec.mimeType,
          payloadType,
          clockRate: codec.clockRate,
          channels: codec.channels,
          parameters: {
            useinbandfec: 1,
            stereo: codec.channels > 1 ? 1 : 0,
          },
        },
      ],
      encodings: [
        {
          ssrc,
        },
      ],
      rtcp: {
        cname,
        reducedSize: true,
      },
    };

    const producer = await transport.produce({
      kind: "audio",
      rtpParameters,
    });

    const feedId = getServerFeedId(roomId);
    const name = SERVER_FEED_NAME;

    const commandReplaced = SERVER_FEED_COMMAND.replaceAll("{ip}", transport.tuple.localIp)
      .replaceAll("{port}", String(transport.tuple.localPort))
      .replaceAll("{payloadType}", String(payloadType))
      .replaceAll("{ssrc}", String(ssrc));

    const tokens = tokenizeCommand(commandReplaced).filter(Boolean);
    if (tokens.length === 0) {
      await producer.close();
      await transport.close();
      throw new Error("SERVER_AUDIO_COMMAND did not resolve to an executable command");
    }

    const [cmd, ...args] = tokens;
    console.log("Starting house feed process:", cmd, args.join(" "));
    const child = spawn(cmd, args, {
      stdio: "ignore",
    });

    const feed = {
      transport,
      producer,
      child,
      feedId,
      name,
      producerId: producer.id,
    };
    roomState.serverFeed = feed;

    child.on("exit", (code, signal) => {
      const reason = `process-exit:${code ?? "null"}:${signal ?? "null"}`;
      if (rooms[roomId]?.serverFeed?.child === child) {
        stopServerFeed(roomId, { skipProcessKill: true, reason }).catch((err) =>
          console.warn("Failed to stop server feed after process exit", err)
        );
      }
    });

    child.on("error", (err) => {
      console.error("House feed process error:", err);
      if (rooms[roomId]?.serverFeed?.child === child) {
        stopServerFeed(roomId, {
          skipProcessKill: true,
          reason: `process-error:${err?.code || err?.message || "unknown"}`,
        }).catch((error) => console.warn("Failed to stop server feed after process error", error));
      }
    });

    producer.on("transportclose", () => {
      stopServerFeed(roomId, { skipProcessKill: true, reason: "transport-close" }).catch(() => {});
    });

    producer.on("close", () => {
      stopServerFeed(roomId, { skipProcessKill: true, reason: "producer-close" }).catch(() => {});
    });

    io.to(roomId).emit("peer-joined", { id: feedId, admin: false, name, serverFeed: true });
    io.to(roomId).emit("server-feed-state", { roomId, enabled: true, id: feedId, name });
    io.to(roomId).emit("new-producer", {
      producerId: producer.id,
      socketId: feedId,
      serverFeed: true,
      name,
    });

    return feed;
  }

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Accept room and admin directly from handshake query (no tokens)
    const qs = socket.handshake.query || {};
    const rawRoom = Array.isArray(qs.room) ? qs.room[0] : qs.room;
    const adminFlag = qs.admin === "1" || qs.admin === "true";
    const room = typeof rawRoom === "string" ? rawRoom.trim() : "";

    let displayName = Array.isArray(qs.name) ? qs.name[0] : qs.name;
    displayName = typeof displayName === "string" ? displayName.trim() : "";
    if (displayName) {
      displayName = displayName.replace(/\s+/g, " ");
    }

    if (!room || !ROOMS.includes(room)) {
      socket.emit("error", "missing or invalid room");
      socket.disconnect(true);
      return;
    }

    if (!displayName) {
      socket.emit("error", "display name required");
      socket.disconnect(true);
      return;
    }

    if (displayName.length > 60) {
      displayName = displayName.slice(0, 60);
    }

    socket.data.isAdmin = !!adminFlag;
    socket.data.room = room;
    socket.data.displayName = displayName;

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
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: INITIAL_AVAILABLE_BITRATE,
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
        await transport.connect({ dtlsParameters });
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

    // list current producers in the room (excluding requester)
    socket.on("getProducers", ({ roomId }, callback) => {
      const list = [];
      const roomStateLocal = rooms[roomId];
      const peers = roomStateLocal?.peers || {};
      for (const [id, p] of Object.entries(peers)) {
        if (p.producerId && id !== socket.id) list.push({ producerId: p.producerId, socketId: id });
      }
      if (roomStateLocal?.serverFeed?.producerId) {
        list.push({
          producerId: roomStateLocal.serverFeed.producerId,
          socketId: roomStateLocal.serverFeed.feedId,
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
          paused: false,
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

    const cleanupPeer = () => {
      if (socket.data.__cleaned) {
        return;
      }
      socket.data.__cleaned = true;

      const joinedRoom = socket.data.room;

      for (const [roomId, roomObj] of Object.entries(rooms)) {
        const peer = roomObj.peers[socket.id];
        if (!peer) continue;

        if (peer.producer) {
          try {
            peer.producer.close();
          } catch (e) {}
          socket
            .to(roomId)
            .emit("producer-closed", { producerId: peer.producerId });
        }

        if (peer.consumers) {
          for (const c of Object.values(peer.consumers)) {
            try {
              c.close();
            } catch (e) {}
          }
        }

        if (peer.transports) {
          for (const t of Object.values(peer.transports)) {
            try {
              t.close();
            } catch (e) {}
          }
        }

        delete roomObj.peers[socket.id];
        console.log(`Peer ${socket.id} left room ${roomId}`);

        if (Object.keys(roomObj.peers).length === 0) {
          if (roomObj.serverFeed) {
            stopServerFeed(roomId).catch((err) =>
              console.warn("Failed to stop server feed after last peer left", err)
            );
          } else {
            delete rooms[roomId];
          }
        }
      }

      if (joinedRoom) {
        socket.to(joinedRoom).emit("peer-left", {
          id: socket.id,
          name: socket.data.displayName,
        });
        try {
          socket.leave(joinedRoom);
        } catch (e) {}
      }
    };

    socket.on("disconnecting", cleanupPeer);
    socket.on("disconnect", cleanupPeer);

    socket.on("setServerFeed", async ({ roomId, enabled }, callback = () => {}) => {
      if (!socket.data.isAdmin) {
        callback({ error: "not authorized" });
        return;
      }
      if (!roomId || socket.data.room !== roomId) {
        callback({ error: "invalid room" });
        return;
      }

      try {
        if (enabled) {
          await startServerFeed(roomId);
        } else {
          await stopServerFeed(roomId);
        }
        callback({ ok: true, enabled: !!enabled });
      } catch (err) {
        console.error("setServerFeed error", err);
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
//           callback({
//             id: consumer.id,
//             producerId,
//             kind: consumer.kind,
//             rtpParameters: consumer.rtpParameters,
//           });

//     socket.on("disconnect", () => {
//       // cleanup this peer's transports/producers/consumers
//       for (const [roomId, roomObj] of Object.entries(rooms)) {
//         const peer = roomObj.peers[socket.id];
//         if (!peer) continue;

//         // close producers
//         if (peer.producer) {
//           try {
//             peer.producer.close();
//           } catch (e) {}
//           socket.to(roomId).emit("producer-closed", { producerId: peer.producerId });
//         }

//         // close consumers
//         if (peer.consumers) {
//           for (const c of Object.values(peer.consumers)) {
//             try {
//               c.close();
//             } catch (e) {}
//           }
//         }

//         // close transports
//         if (peer.transports) {
//           for (const t of Object.values(peer.transports)) {
//             try {
//               t.close();
//             } catch (e) {}
//           }
//         }

//         delete roomObj.peers[socket.id];
//         console.log(`Peer ${socket.id} left room ${roomId}`);
//       }
//       socket.to(room).emit("peer-left", { id: socket.id });
//     });

//   server.listen(PORT, () => {
//     console.log(`Server running on http://localhost:${PORT}`);
//     console.log(`Rooms: ${ROOMS.join(", ")}`);
//   });

// start();
