import { spawn } from "child_process";
import dgram from "dgram";
import fs from "fs";
import os from "os";
import path from "path";

import config from "./config.js";
import { ffmpegAudioDevice } from "./devices.js";

const OPUS_PAYLOAD_TYPE = 111;
const OPUS_CLOCK_RATE = 48000;

function log(...args) {
  console.log("[audio]", ...args);
}

function debug(...args) {
  if (config.debugAudio) console.log("[audio:debug]", ...args);
}

/**
 * Bind a UDP socket on an ephemeral port, note the number, release it.
 *
 * There is an inherent race between releasing and the child process binding,
 * but the kernel does not immediately recycle a just-freed ephemeral port, and
 * this is dramatically better than the previous `30000 + Math.random() * 10000`
 * which collided silently whenever two streams overlapped.
 */
function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

/**
 * Signals a child process and waits for it to actually be gone, escalating to
 * SIGKILL if it ignores the polite request.
 *
 * The waiting is the point. A sound card is an exclusive resource: ffmpeg holds
 * the ALSA device open until the moment it exits, and an ffmpeg blocked on an
 * RTP read can take several seconds to notice SIGTERM. Returning before it has
 * gone lets the next session spawn an ffmpeg that finds the card busy, which
 * fails the open and leaves the stream silent — intermittently, because it only
 * happens when the restart lands inside that window.
 */
export function terminateChild(child, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(escalate);
      clearTimeout(giveUp);
      resolve();
    };

    const escalate = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceMs);

    // A process wedged in uninterruptible IO survives even SIGKILL. Waiting
    // forever would hang the intercom, so past this point we accept the risk of
    // a busy card over a request that never returns.
    const giveUp = setTimeout(finish, graceMs + 2000);

    child.once("exit", finish);

    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

/**
 * ffmpeg reports plenty of routine progress on stderr, so only real problems
 * are surfaced unless DEBUG_AUDIO is on -- the appliance logs to a journal on
 * flash and writes cost endurance.
 *
 * "xrun" earns its place here: an ALSA underrun is what a starved output sounds
 * like, and it is the audible artefact users actually report ("a noise that
 * repeats after I stop talking"). It was previously filtered out, which made
 * that bug invisible in the logs while it was happening.
 */
const FFMPEG_PROBLEM =
  /error|cannot|unable|no such|denied|busy|xrun|underrun|overrun/i;

function randomSsrc() {
  // RTP SSRC is an unsigned 32-bit value, but ffmpeg's `-ssrc` option is parsed
  // as a *signed* int and rejects anything above 2147483647 with "out of range",
  // which stops the capture process from starting at all. Staying inside the
  // positive signed range keeps both ffmpeg and mediasoup happy.
  return 1 + Math.floor(Math.random() * 0x7ffffffe);
}

/**
 * Captures a multi-channel hardware input and publishes each channel as its own
 * independent mono mediasoup producer.
 *
 * The single-process design is forced by ALSA: a hardware device (`hw:X,Y`)
 * can only be opened by one process at a time, so two channels cannot mean two
 * capture processes. Instead one ffmpeg reads all channels and fans them out to
 * one RTP stream per channel via the `pan` filter.
 *
 * Producers and transports are created once and outlive the ffmpeg process, so
 * a capture crash (device unplugged, USB re-enumeration) reconnects without
 * disturbing any connected listener.
 */
export class AudioCapture {
  constructor(router) {
    this.router = router;
    this.settings = config.audio.capture;
    this.feeds = [];
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
    this.restartDelayMs = this.settings.restartDelayMs;
    this.lastError = null;
    this.running = false;
  }

  /** Feed metadata safe to hand to clients. */
  getFeeds() {
    return this.feeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      producerId: feed.producer?.id || null,
      available: !!feed.producer && !feed.producer.closed,
    }));
  }

  /**
   * Includes per-feed byte counters straight from mediasoup.
   *
   * A running ffmpeg process does not prove audio is arriving — a muted input,
   * a wrong channel count, or a silently failing RTP path all leave the process
   * happily alive. `bytesReceived` climbing between two health checks is the
   * only real evidence, and it is what to look at first when someone reports
   * a dead feed.
   */
  async getStatus() {
    const feeds = await Promise.all(
      this.feeds.map(async (feed) => {
        let bytesReceived = null;
        try {
          const stats = await feed.producer.getStats();
          bytesReceived = stats?.[0]?.byteCount ?? 0;
        } catch {
          // Producer closed mid-check; report unknown rather than failing.
        }
        return { id: feed.id, name: feed.name, bytesReceived };
      })
    );

    return {
      enabled: this.settings.enabled,
      running: this.running,
      device: this.settings.device,
      channels: this.feeds.length,
      lastError: this.lastError,
      feeds,
    };
  }

  /**
   * Repoints capture at a different sound card while the server keeps running.
   *
   * Only the ffmpeg process is replaced. Transports and producers outlive it by
   * design, so everyone listening to a feed stays connected across the swap
   * instead of having their audio element torn down and rebuilt.
   */
  setDevice(device) {
    if (!device || device === this.settings.device) return false;

    log(`capture device changing: ${this.settings.device} -> ${device}`);
    this.settings.device = device;
    this.lastError = null;

    // Any pending retry is for the old device, and its backoff may be tens of
    // seconds by now. Drop it and start the new device from a clean delay.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartDelayMs = this.settings.restartDelayMs;

    const alive =
      this.child && this.child.exitCode === null && this.child.signalCode === null;

    if (alive) {
      // The exit handler respawns; spawning here too would leave two ffmpegs
      // fighting over one card.
      try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    } else if (this.settings.enabled && this.feeds.length > 0) {
      this.#spawnCapture();
    }

    return true;
  }

  async start() {
    if (!this.settings.enabled) {
      log("capture disabled (AUDIO_CAPTURE_ENABLED is not set)");
      return;
    }

    if (this.settings.channels.length === 0) {
      log("capture enabled but no channels configured");
      return;
    }

    await this.#createFeeds();
    this.#spawnCapture();
  }

  /**
   * One PlainTransport + producer per channel. comedia is deliberately off: we
   * pin ffmpeg's source port instead, so a restarted ffmpeg lands on the exact
   * endpoint mediasoup already expects rather than relying on re-detection.
   */
  async #createFeeds() {
    for (const channel of this.settings.channels) {
      const transport = await this.router.createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        enableUdp: true,
        enableTcp: false,
        rtcpMux: true,
        comedia: false,
      });

      const ssrc = randomSsrc();
      const sourcePort = await reserveUdpPort();

      await transport.connect({ ip: "127.0.0.1", port: sourcePort });

      const producer = await transport.produce({
        kind: "audio",
        rtpParameters: {
          codecs: [
            {
              mimeType: "audio/opus",
              payloadType: OPUS_PAYLOAD_TYPE,
              clockRate: OPUS_CLOCK_RATE,
              channels: 2, // Opus always negotiates 2; the payload itself is mono.
              parameters: { useinbandfec: 1, "sprop-stereo": 0 },
            },
          ],
          encodings: [{ ssrc }],
        },
      });

      this.feeds.push({
        ...channel,
        transport,
        producer,
        ssrc,
        sourcePort,
        destinationPort: transport.tuple.localPort,
      });

      log(
        `feed "${channel.name}" (${channel.id}) ready: ` +
          `channel ${channel.index} -> rtp 127.0.0.1:${transport.tuple.localPort}`
      );
    }
  }

  #buildFfmpegArgs() {
    const { device, format, sampleRate, bitratePerChannel, channels } = this.settings;

    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel", config.debugAudio ? "info" : "warning",
      // Keep the capture path as short as possible; this is a live intercom.
      "-fflags", "+nobuffer",
      "-flags", "low_delay",
      "-f", format,
    ];

    // Channel and rate are input options for a real capture device. A lavfi
    // generator carries its own, and forcing them here makes ffmpeg fail.
    if (format === "lavfi") {
      // A sound card paces capture at realtime; a synthetic generator does not
      // and will otherwise produce ~100x realtime, which is useless as a test.
      args.push("-re");
    } else {
      args.push("-ac", String(channels.length), "-ar", String(sampleRate));
    }

    args.push("-i", ffmpegAudioDevice(device, format));

    // `pan` is used rather than `channelsplit` because it works for any channel
    // count without needing a named layout (quad, 5.1, ...).
    const filters = channels
      .map((channel) => `[0:a]pan=mono|c0=c${channel.index}[out${channel.index}]`)
      .join(";");
    args.push("-filter_complex", filters);

    for (const feed of this.feeds) {
      args.push(
        "-map", `[out${feed.index}]`,
        "-c:a", "libopus",
        "-application", "lowdelay",
        "-frame_duration", "20",
        "-b:a", String(bitratePerChannel),
        "-ac", "1",
        "-ssrc", String(feed.ssrc),
        "-payload_type", String(OPUS_PAYLOAD_TYPE),
        "-f", "rtp",
        `rtp://127.0.0.1:${feed.destinationPort}?localrtpport=${feed.sourcePort}&pkt_size=1200`
      );
    }

    return args;
  }

  #spawnCapture() {
    if (this.stopping) return;

    const args = this.#buildFfmpegArgs();
    debug("ffmpeg", args.join(" "));

    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (!message) return;
      if (config.debugAudio || FFMPEG_PROBLEM.test(message)) {
        log(`ffmpeg: ${message}`);
        this.lastError = message;
      }
    });

    child.on("spawn", () => {
      this.running = true;
      this.restartDelayMs = this.settings.restartDelayMs;
      log(`capture started on ${this.settings.device} (${this.feeds.length} channels)`);
    });

    child.on("error", (err) => {
      this.running = false;
      this.lastError = err.message;
      if (err.code === "ENOENT") {
        log("ffmpeg not found on PATH — capture cannot run");
      } else {
        log(`capture process error: ${err.message}`);
      }
      this.#scheduleRestart();
    });

    child.on("exit", (code, signal) => {
      this.running = false;
      if (this.stopping) return;
      log(`capture exited (code=${code}, signal=${signal}) — restarting`);
      this.#scheduleRestart();
    });
  }

  /**
   * Exponential backoff, capped. A missing or busy sound card must not turn
   * into a spawn loop that pegs the CPU and floods the log partition.
   */
  #scheduleRestart() {
    if (this.stopping || this.restartTimer) return;

    const delay = this.restartDelayMs;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.#spawnCapture();
    }, delay);
    // Do not let a pending retry hold the process open during shutdown.
    this.restartTimer.unref?.();

    this.restartDelayMs = Math.min(
      this.restartDelayMs * 2,
      this.settings.restartDelayMaxMs
    );
    debug(`next capture restart in ${delay}ms`);
  }

  async stop() {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.child) {
      // Wait for the card to be released rather than just asking. A restart
      // that spawns the next capture while this one still holds the device
      // fails the open, and the house feed comes back silent.
      const child = this.child;
      this.child = null;
      await terminateChild(child);
    }

    for (const feed of this.feeds) {
      try {
        feed.producer?.close();
      } catch {
        // Already closed.
      }
      try {
        feed.transport?.close();
      } catch {
        // Already closed.
      }
    }

    this.feeds = [];
    this.running = false;
  }
}

/**
 * Routes one participant's audio out of the server's physical audio output.
 *
 * Uses ffmpeg rather than ffplay: ffplay is a media *player* that links SDL and
 * expects a display, which makes it a poor fit for a headless container even
 * with -nodisp. `ffmpeg -f alsa` writes straight to the device.
 */
export class AudioPlayback {
  constructor(router) {
    this.router = router;
    this.settings = config.audio.playback;
    this.session = null;
  }

  get active() {
    return !!this.session;
  }

  getStatus() {
    return {
      enabled: this.settings.enabled,
      active: this.active,
      device: this.settings.device,
      ownerSocketId: this.session?.socketId || null,
    };
  }

  /**
   * Repoints the output. The device name is only read when ffmpeg is spawned,
   * so a live stream would carry on feeding the old card — it is stopped rather
   * than left running somewhere the admin no longer expects it to be heard.
   * Returns whether a stream was interrupted, so the caller can say so.
   */
  async setDevice(device) {
    if (!device || device === this.settings.device) return false;

    log(`playback device changing: ${this.settings.device} -> ${device}`);
    this.settings.device = device;

    if (!this.active) return false;
    await this.stop(null, "output device changed");
    return true;
  }

  /**
   * Only one stream can own the output device at a time — ALSA will not mix two
   * writers to a hardware device, and two people talking over the house
   * speakers at once is not desirable anyway.
   */
  async start(socketId, producerId) {
    if (!this.settings.enabled) {
      throw new Error("Server audio output is not enabled on this installation");
    }

    if (this.session && this.session.socketId !== socketId) {
      throw new Error("Another admin is already streaming to the server output");
    }

    if (this.session) return this.getStatus();

    if (!this.router.canConsume({ producerId, rtpCapabilities: this.router.rtpCapabilities })) {
      throw new Error("Cannot consume that producer — it may have closed");
    }

    const transport = await this.router.createPlainTransport({
      listenIp: { ip: "127.0.0.1" },
      enableUdp: true,
      enableTcp: false,
      rtcpMux: true,
      comedia: false,
    });

    let consumer;
    let sdpPath;
    let child;

    try {
      consumer = await transport.consume({
        producerId,
        rtpCapabilities: this.router.rtpCapabilities,
        paused: true,
      });

      const codec = consumer.rtpParameters.codecs[0];
      const listenPort = await reserveUdpPort();

      const sdp = [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=Church Intercom Server Output",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        `m=audio ${listenPort} RTP/AVP ${codec.payloadType}`,
        `a=rtpmap:${codec.payloadType} opus/${codec.clockRate}/${codec.channels || 2}`,
        `a=fmtp:${codec.payloadType} minptime=10;useinbandfec=1`,
        "a=recvonly",
        "",
      ].join("\n");

      sdpPath = path.join(os.tmpdir(), `intercom-out-${socketId}-${process.pid}.sdp`);
      fs.writeFileSync(sdpPath, sdp, { mode: 0o600 });

      child = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-loglevel", config.debugAudio ? "info" : "warning",
          "-protocol_whitelist", "file,rtp,udp",
          "-fflags", "+nobuffer",
          "-flags", "low_delay",
          "-i", sdpPath,
          "-f", this.settings.format,
          ffmpegAudioDevice(this.settings.device, this.settings.format),
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      this.session = { socketId, transport, consumer, child, sdpPath, listenPort };

      child.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();
        if (!message) return;
        if (config.debugAudio || FFMPEG_PROBLEM.test(message)) {
          log(`playback ffmpeg: ${message}`);
        }
      });

      // Wait for ffmpeg to actually bind the RTP port instead of sleeping a
      // fixed 500ms and hoping. Probing avoids both a needless delay on a fast
      // boot and a silent failure on a slow one.
      await this.#waitForPort(listenPort, child);

      await transport.connect({ ip: "127.0.0.1", port: listenPort });
      await consumer.resume();

      consumer.on("producerclose", () => {
        this.stop(socketId, "producer-closed").catch(() => {});
      });
      consumer.on("transportclose", () => {
        this.stop(socketId, "transport-closed").catch(() => {});
      });

      child.on("exit", (code, signal) => {
        if (this.session?.child !== child) return;
        log(`playback exited (code=${code}, signal=${signal})`);
        this.stop(socketId, `process-exit:${code ?? signal}`).catch(() => {});
      });

      child.on("error", (err) => {
        log(`playback process error: ${err.message}`);
        this.stop(socketId, `process-error:${err.message}`).catch(() => {});
      });

      log(`playback started for ${socketId} -> ${this.settings.device}`);
      return this.getStatus();
    } catch (error) {
      // Roll back anything that did get created so a failed start leaves no
      // orphaned transport, process, or temp file behind.
      this.session = null;
      // Same reasoning as stop(): a start that failed half way must not leave
      // an ffmpeg holding the card while the admin taps the button again.
      await terminateChild(child);
      if (sdpPath) {
        try { fs.unlinkSync(sdpPath); } catch { /* already removed */ }
      }
      try { consumer?.close(); } catch { /* already closed */ }
      try { transport.close(); } catch { /* already closed */ }
      throw error;
    }
  }

  /**
   * Poll until the port stops accepting a bind, which means ffmpeg has taken
   * it. Gives up quickly so a broken ffmpeg surfaces as an error rather than a
   * hang.
   */
  async #waitForPort(port, child, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error("ffmpeg exited before it could open the audio output");
      }

      const free = await new Promise((resolve) => {
        const probe = dgram.createSocket("udp4");
        probe.once("error", () => resolve(false));
        probe.bind(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });

      if (!free) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out waiting for the audio output process to start");
  }

  async stop(socketId, reason = "stopped") {
    const session = this.session;
    if (!session) return;
    if (socketId && session.socketId !== socketId) return;

    this.session = null;

    // Close the mediasoup side first so no more RTP is sent at a process that
    // is on its way out, then wait for ffmpeg to release the sound card. The
    // wait is what makes an immediate restart safe: `this.session` is already
    // null here, so nothing else stops the next start() from spawning an ffmpeg
    // while this one still owns the device.
    try { session.consumer?.close(); } catch { /* already closed */ }
    try { session.transport?.close(); } catch { /* already closed */ }

    await terminateChild(session.child);

    try { fs.unlinkSync(session.sdpPath); } catch { /* already removed */ }

    log(`playback stopped for ${session.socketId}: ${reason}`);
  }
}
