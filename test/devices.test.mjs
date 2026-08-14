// Checks the device-list parsers against real tool output.
//
// The ALSA half matters most and is the half that cannot be run on a Mac: the
// appliance is Linux, `hw:CARD,DEV` is what ffmpeg is handed, and getting the
// card number wrong points the intercom at the wrong sound card. The fixtures
// below are verbatim `arecord -l` / `aplay -l` output.
import assert from "node:assert/strict";

import { ffmpegAudioDevice, parseAlsaList, parseAvfoundationAudio } from "../devices.js";

let failures = 0;

function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       got      ${JSON.stringify(actual)}`);
    console.error(`       expected ${JSON.stringify(expected)}`);
  }
}

console.log("ALSA parsing (the appliance's real path)");

const ARECORD = `**** List of CAPTURE Hardware Devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC3232 Analog [ALC3232 Analog]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 1: USB [Scarlett 2i2 USB], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
`;

check("two cards, ids and names", parseAlsaList(ARECORD), [
  { id: "hw:0,0", name: "HDA Intel PCH — ALC3232 Analog" },
  { id: "hw:1,0", name: "Scarlett 2i2 USB — USB Audio" },
]);

const APLAY_MULTI_DEVICE = `**** List of PLAYBACK Hardware Devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC3232 Analog [ALC3232 Analog]
  Subdevices: 1/1
card 0: PCH [HDA Intel PCH], device 3: HDMI 0 [HDMI 0]
  Subdevices: 1/1
`;

check("second device on the same card", parseAlsaList(APLAY_MULTI_DEVICE), [
  { id: "hw:0,0", name: "HDA Intel PCH — ALC3232 Analog" },
  { id: "hw:0,3", name: "HDA Intel PCH — HDMI 0" },
]);

// When the card and device descriptions are identical, repeating them reads
// like a stutter in the dropdown.
check(
  "identical card and device names are not doubled",
  parseAlsaList("card 2: USB [USB Audio], device 0: USB Audio [USB Audio]\n"),
  [{ id: "hw:2,0", name: "USB Audio" }]
);

check("no cards attached", parseAlsaList("**** List of CAPTURE Hardware Devices ****\n"), []);
check("empty output", parseAlsaList(""), []);
check("error text from a missing tool", parseAlsaList("no soundcards found..."), []);

console.log("\navfoundation parsing (macOS development machines)");

const AVFOUNDATION = `[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] Capture screen 0
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8] [1] Scarlett 2i2
`;

// The video list uses the same [N] numbering, so a parser that ignores the
// section headings returns cameras as microphones.
check("audio devices only, not cameras", parseAvfoundationAudio(AVFOUNDATION), [
  { id: ":0", name: "MacBook Pro Microphone" },
  { id: ":1", name: "Scarlett 2i2" },
]);

check("no audio section", parseAvfoundationAudio("[AVFoundation indev @ 0x7f8] AVFoundation video devices:\n[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera\n"), []);
check("empty output", parseAvfoundationAudio(""), []);

console.log("\nffmpeg device rewriting (hw: opens raw and will not convert)");

// The failure this prevents is not subtle: ffmpeg exits with "cannot set
// channel count to 1 (Invalid argument)" and nothing is ever played.
check("hw: becomes plughw:", ffmpegAudioDevice("hw:0,0"), "plughw:0,0");
check("multi-digit card and device", ffmpegAudioDevice("hw:10,3"), "plughw:10,3");

// Anything that already routes through a plugin, or names a plugin directly,
// must be passed through untouched.
check("plughw: left alone", ffmpegAudioDevice("plughw:1,0"), "plughw:1,0");
check("default left alone", ffmpegAudioDevice("default"), "default");
check("sysdefault left alone", ffmpegAudioDevice("sysdefault:CARD=PCH"), "sysdefault:CARD=PCH");

// avfoundation indices are ":0", and lavfi carries a generator expression;
// prefixing either with plughw would break a working configuration.
check("avfoundation untouched", ffmpegAudioDevice(":1", "avfoundation"), ":1");
check("lavfi untouched", ffmpegAudioDevice("sine=f=440", "lavfi"), "sine=f=440");
check("hw: under a non-alsa format untouched", ffmpegAudioDevice("hw:0,0", "lavfi"), "hw:0,0");

check("undefined device", ffmpegAudioDevice(undefined), undefined);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
