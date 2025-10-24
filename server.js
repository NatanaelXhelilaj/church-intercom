import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";

// add these imports to compute __dirname in ESM
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

async function start() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // compute __dirname for ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const PORT = process.env.PORT || 3000;
  const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "127.0.0.1"; // change to your public/LAN IP
  const MAX_INCOMING_BITRATE = parseInt(process.env.MAX_INCOMING_BITRATE || "800000", 10);
  const INITIAL_AVAILABLE_BITRATE = parseInt(process.env.INITIAL_AVAILABLE_BITRATE || "1000000", 10);

  // Config: 8 rooms named room1..room8
  const ROOMS = Array.from({ length: 8 }, (_, i) => `room${i + 1}`);

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

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Accept room and admin directly from handshake query (no tokens)
    const qs = socket.handshake.query || {};
    const room = qs.room;
    const adminFlag = qs.admin === "1" || qs.admin === "true";

    if (!room || !ROOMS.includes(room)) {
      socket.emit("error", "missing or invalid room");
      socket.disconnect(true);
      return;
    }

    socket.data.isAdmin = !!adminFlag;
    socket.data.room = room;

    socket.join(room);

    // collect existing peers in room
    const peers = Array.from(io.sockets.adapter.rooms.get(room) || []);
    const otherPeers = peers.filter((id) => id !== socket.id);

    // send existing peers to joining client
    socket.emit(
      "peers",
      otherPeers.map((id) => ({
        id,
        admin: !!io.sockets.sockets.get(id)?.data?.isAdmin,
      }))
    );

    // notify others
    socket.to(room).emit("peer-joined", { id: socket.id, admin: socket.data.isAdmin });

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
      target.emit("kicked", { by: socket.id });
      setTimeout(() => target.disconnect(true), 200);
    });

    // Ensure room bookkeeping
    socket.on("joinRoom", async ({ roomId }, callback) => {
      if (!rooms[roomId]) rooms[roomId] = { peers: {} };
      rooms[roomId].peers[socket.id] = rooms[roomId].peers[socket.id] || {
        transports: {},
        consumers: {},
      };
      callback && callback({ joined: true });
    });

    // return router rtpCapabilities
    socket.on("getRtpCapabilities", (callback) => {
      callback && callback(router.rtpCapabilities);
    });

    // create transport
    socket.on("createTransport", async ({ roomId }, callback) => {
      if (!rooms[roomId]) rooms[roomId] = { peers: {} };
      rooms[roomId].peers[socket.id] =
        rooms[roomId].peers[socket.id] || { transports: {}, consumers: {} };

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

        rooms[roomId].peers[socket.id].transports[transport.id] = transport;

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
        rooms[roomId].peers[socket.id].producer = producer;
        rooms[roomId].peers[socket.id].producerId = producer.id;

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
      const peers = rooms[roomId]?.peers || {};
      for (const [id, p] of Object.entries(peers)) {
        if (p.producerId && id !== socket.id) list.push({ producerId: p.producerId, socketId: id });
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

        rooms[roomId].peers[socket.id].consumers[consumer.id] = consumer;

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

    socket.on("disconnect", () => {
      // cleanup this peer's transports/producers/consumers
      for (const [roomId, roomObj] of Object.entries(rooms)) {
        const peer = roomObj.peers[socket.id];
        if (!peer) continue;

        // close producers
        if (peer.producer) {
          try {
            peer.producer.close();
          } catch (e) {}
          socket.to(roomId).emit("producer-closed", { producerId: peer.producerId });
        }

        // close consumers
        if (peer.consumers) {
          for (const c of Object.values(peer.consumers)) {
            try {
              c.close();
            } catch (e) {}
          }
        }

        // close transports
        if (peer.transports) {
          for (const t of Object.values(peer.transports)) {
            try {
              t.close();
            } catch (e) {}
          }
        }

        delete roomObj.peers[socket.id];
        console.log(`Peer ${socket.id} left room ${roomId}`);
      }
      socket.to(room).emit("peer-left", { id: socket.id });
    });
  });

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
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
