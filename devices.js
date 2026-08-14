/**
 * Enumerates the sound cards attached to the *server*, so an admin can pick
 * which one the intercom captures from and plays out to without editing .env
 * and restarting the box mid-service.
 *
 * ffmpeg's own listing APIs (`ffmpeg -sources` / `-sinks`) report "Function not
 * implemented" for both alsa and avfoundation, so each platform is enumerated
 * with the tool that actually answers:
 *
 *   Linux   arecord -l / aplay -l, giving the hw:CARD,DEV strings ffmpeg wants.
 *   macOS   ffmpeg's own avfoundation device list for inputs. Outputs are not
 *           enumerable there at all (see listOutputDevices), which is why the
 *           appliance runs Linux.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

import config from "./config.js";

const execFileAsync = promisify(execFile);

const IS_LINUX = process.platform === "linux";
const IS_MACOS = process.platform === "darwin";

/**
 * Runs a command and returns its output whatever the exit status.
 *
 * `ffmpeg -list_devices` prints the list and then exits non-zero because it was
 * given no real input to open. That is success for our purposes.
 */
async function captureOutput(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    if (error.stdout != null || error.stderr != null) {
      return `${error.stdout || ""}\n${error.stderr || ""}`;
    }
    throw error;
  }
}

/**
 * Rewrites an ALSA `hw:` device to the `plughw:` form before it is handed to
 * ffmpeg.
 *
 * `hw:` opens the card raw: the sample rate, sample format and channel count
 * have to be exactly what the hardware accepts, and anything else fails the
 * open outright. On this codec that is a stereo-only device, so a mono stream
 * dies with "cannot set channel count to 1 (Invalid argument)" and playback
 * stops before a single sample is written. `plughw:` is the same device with
 * ALSA's conversion layer in front, which resamples and remixes as needed.
 *
 * The `hw:CARD,DEV` form is kept everywhere else on purpose. It is what
 * `arecord -l` reports, what the admin picks from, and what the allowlist
 * compares against — these strings become ffmpeg arguments, so widening what
 * that check accepts would widen what ffmpeg can be told to open. Only the
 * value passed to ffmpeg is rewritten.
 */
export function ffmpegAudioDevice(device, format = "alsa") {
  if (format !== "alsa" || typeof device !== "string") return device;
  // Leave `default`, `sysdefault:…`, `dmix:…` and an explicit `plughw:` alone.
  return device.startsWith("hw:") ? `plughw:${device.slice(3)}` : device;
}

/**
 * Parses `arecord -l` / `aplay -l`, whose lines look like:
 *   card 1: USB [Scarlett 2i2 USB], device 0: USB Audio [USB Audio]
 */
export function parseAlsaList(text) {
  const devices = [];
  const pattern =
    /^card (\d+): \S+ \[([^\]]+)\], device (\d+): [^[]*\[([^\]]+)\]/gm;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, card, cardName, device, deviceName] = match;
    devices.push({
      id: `hw:${card},${device}`,
      name: cardName === deviceName ? cardName : `${cardName} — ${deviceName}`,
    });
  }
  return devices;
}

/**
 * Parses ffmpeg's avfoundation listing. Video devices are listed first under
 * their own heading and share the same index space per type, so the audio
 * section has to be isolated before reading indices.
 */
export function parseAvfoundationAudio(text) {
  const devices = [];
  let inAudioSection = false;

  for (const line of text.split("\n")) {
    if (/AVFoundation video devices:/.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (/AVFoundation audio devices:/.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;

    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!match) continue;
    devices.push({ id: `:${match[1]}`, name: match[2] });
  }
  return devices;
}

export async function listInputDevices() {
  if (IS_LINUX) {
    return parseAlsaList(await captureOutput("arecord", ["-l"]));
  }
  if (IS_MACOS) {
    return parseAvfoundationAudio(
      await captureOutput("ffmpeg", [
        "-hide_banner",
        "-f", "avfoundation",
        "-list_devices", "true",
        "-i", "",
      ])
    );
  }
  return [];
}

export async function listOutputDevices() {
  if (IS_LINUX) {
    return parseAlsaList(await captureOutput("aplay", ["-l"]));
  }
  // macOS has no enumerable output: ffmpeg writes through audiotoolbox, whose
  // -audio_device_index counts every CoreAudio device (inputs included) in an
  // order nothing else on the system reports. A dropdown built on a guessed
  // ordering would quietly send the service audio to the wrong box, so this
  // offers the system default only and says why.
  return [];
}

/**
 * Everything the admin UI needs: what exists, what is selected, and an honest
 * note when a platform cannot offer a choice.
 */
export async function describeAudioDevices({ captureDevice, playbackDevice }) {
  const [input, output] = await Promise.all([
    listInputDevices().catch(() => []),
    listOutputDevices().catch(() => []),
  ]);

  // A device configured earlier may be unplugged now. Keep it in the list,
  // flagged, so the dropdown shows the truth instead of silently jumping to
  // some other card.
  const withCurrent = (devices, current) => {
    if (!current || devices.some((device) => device.id === current)) return devices;
    return [...devices, { id: current, name: `${current} (not detected)`, missing: true }];
  };

  return {
    platform: process.platform,
    input: withCurrent(input, captureDevice),
    output: withCurrent(output, playbackDevice),
    selected: { input: captureDevice, output: playbackDevice },
    outputSelectable: IS_LINUX,
    notes: {
      input: input.length
        ? null
        : IS_LINUX
          ? "No capture devices found. Is the interface plugged in?"
          : "Could not list capture devices on this platform.",
      output: IS_LINUX
        ? output.length
          ? null
          : "No playback devices found. Is the interface plugged in?"
        : "Choosing an output device is only supported on Linux (ALSA); " +
          "this platform uses the system default.",
    },
  };
}

// ------------------------------------------------------------- persistence

/**
 * The selection has to outlive a restart, and it cannot live in .env: that file
 * is edited by hand and is not writable on a locked-down appliance image.
 */
export function loadDeviceSelection() {
  try {
    const raw = fs.readFileSync(config.audio.settingsPath, "utf8");
    const saved = JSON.parse(raw);
    return {
      captureDevice: typeof saved.captureDevice === "string" ? saved.captureDevice : null,
      playbackDevice: typeof saved.playbackDevice === "string" ? saved.playbackDevice : null,
    };
  } catch {
    // Absent or unreadable means "never chosen"; .env stays the default.
    return { captureDevice: null, playbackDevice: null };
  }
}

export function saveDeviceSelection(selection) {
  const file = config.audio.settingsPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
}
