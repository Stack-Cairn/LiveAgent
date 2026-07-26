import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const voice = loader.loadModule("src/lib/voice/speechRecognition.ts");
const crateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(crateRoot, "../..");

function createFakeRecognition() {
  return {
    lang: "",
    continuous: false,
    interimResults: false,
    maxAlternatives: 0,
    startCalls: 0,
    stopCalls: 0,
    abortCalls: 0,
    onstart: null,
    onend: null,
    onerror: null,
    onresult: null,
    start() {
      this.startCalls += 1;
    },
    stop() {
      this.stopCalls += 1;
    },
    abort() {
      this.abortCalls += 1;
    },
  };
}

function recognitionResult(transcript, isFinal) {
  return { 0: { transcript }, isFinal, length: 1 };
}

test("composeVoiceTranscript appends English with a space", () => {
  assert.equal(voice.composeVoiceTranscript("Hello", "world", ""), "Hello world");
  assert.equal(voice.composeVoiceTranscript("Hello", "world", "now"), "Hello world now");
});

test("composeVoiceTranscript keeps CJK without an extra space", () => {
  assert.equal(voice.composeVoiceTranscript("你好", "世界", ""), "你好世界");
  assert.equal(voice.composeVoiceTranscript("请帮我", "打开设置", "面板"), "请帮我打开设置面板");
});

test("composeVoiceTranscript handles empty base or speech", () => {
  assert.equal(voice.composeVoiceTranscript("", "hello", ""), "hello");
  assert.equal(voice.composeVoiceTranscript("keep me", "", ""), "keep me");
  assert.equal(voice.composeVoiceTranscript("  ", "  ", "  "), "");
});

test("appendSpeechChunk concatenates final hypotheses", () => {
  assert.equal(voice.appendSpeechChunk("", "one"), "one");
  assert.equal(voice.appendSpeechChunk("one", "two"), "one two");
  assert.equal(voice.appendSpeechChunk("你好", "世界"), "你好世界");
});

test("mapSpeechRecognitionError maps known codes to i18n keys", () => {
  assert.equal(voice.mapSpeechRecognitionError("not-allowed"), "chat.voice.permissionDenied");
  assert.equal(
    voice.mapSpeechRecognitionError("service-not-allowed"),
    "chat.voice.serviceUnavailable",
  );
  assert.equal(voice.mapSpeechRecognitionError("audio-capture"), "chat.voice.noMicrophone");
  assert.equal(
    voice.mapSpeechRecognitionError("language-not-supported"),
    "chat.voice.languageUnsupported",
  );
  assert.equal(voice.mapSpeechRecognitionError("weird"), "chat.voice.failed");
});

test("composeVoiceTranscriptSuffix preserves existing editor whitespace", () => {
  assert.equal(voice.composeVoiceTranscriptSuffix("Hello", "world", ""), " world");
  assert.equal(voice.composeVoiceTranscriptSuffix("Hello ", "world", ""), "world");
  assert.equal(voice.composeVoiceTranscriptSuffix("你好", "世界", ""), "世界");
  assert.equal(voice.composeVoiceTranscriptSuffix("", "hello", "now"), "hello now");
});

test("only no-speech is recoverable during a continuous session", () => {
  assert.equal(voice.isRecoverableSpeechRecognitionError("no-speech"), true);
  assert.equal(voice.isRecoverableSpeechRecognitionError("network"), false);
  assert.equal(voice.isRecoverableSpeechRecognitionError("service-not-allowed"), false);
  assert.equal(voice.isRecoverableSpeechRecognitionError("language-not-supported"), false);
});

test("isMobileClient is false in node test environment", () => {
  assert.equal(voice.isMobileClient(), false);
});

test("isMobileClient excludes phones and desktop-mode iPads from built-in voice input", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        maxTouchPoints: 5,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
      },
    });
    assert.equal(voice.isMobileClient(), true);

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        maxTouchPoints: 5,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      },
    });
    assert.equal(voice.isMobileClient(), true);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
});

test("insecure browser contexts are rejected before requesting microphone permission", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { isSecureContext: false },
    });
    assert.equal(voice.isSpeechRecognitionSecureContext(), false);

    globalThis.window.isSecureContext = true;
    assert.equal(voice.isSpeechRecognitionSecureContext(), true);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete globalThis.window;
    }
  }
});

test("automatic restart keeps committed text and notifies session start only once", () => {
  const recognition = createFakeRecognition();
  const updates = [];
  let recognitionStarts = 0;
  let sessionStarts = 0;
  let ends = 0;
  const session = voice.createSpeechRecognitionSession(recognition, {
    onRecognitionStart: () => {
      recognitionStarts += 1;
    },
    onSessionStart: () => {
      sessionStarts += 1;
    },
    onUpdate: (payload) => updates.push(payload),
    onEnd: () => {
      ends += 1;
    },
  });

  assert.equal(session.start(), true);
  recognition.onstart();
  recognition.onresult({
    resultIndex: 0,
    results: [recognitionResult("world", true)],
  });
  recognition.onend();
  recognition.onstart();
  recognition.onresult({
    resultIndex: 0,
    results: [recognitionResult("again", true)],
  });

  assert.equal(recognition.startCalls, 2);
  assert.equal(recognitionStarts, 2);
  assert.equal(sessionStarts, 1);
  assert.deepEqual(updates.at(-1), { committed: "world again", interim: "" });

  session.stop();
  recognition.onend();
  assert.equal(recognition.stopCalls, 1);
  assert.equal(ends, 1);
});

test("multiple interim results are joined and fatal errors do not restart", () => {
  const recognition = createFakeRecognition();
  const updates = [];
  const errors = [];
  let ends = 0;
  const session = voice.createSpeechRecognitionSession(recognition, {
    onUpdate: (payload) => updates.push(payload),
    onError: (code) => errors.push(code),
    onEnd: () => {
      ends += 1;
    },
  });

  session.start();
  recognition.onstart();
  recognition.onresult({
    resultIndex: 0,
    results: [recognitionResult("alpha", false), recognitionResult("beta", false)],
  });
  assert.deepEqual(updates.at(-1), { committed: "", interim: "alpha beta" });

  recognition.onerror({ error: "network" });
  recognition.onend();
  assert.deepEqual(errors, ["network"]);
  assert.equal(recognition.startCalls, 1);
  assert.equal(ends, 1);
});

test("macOS bundle declares speech privacy usage and hardened-runtime audio input", () => {
  const infoPlist = fs.readFileSync(path.join(crateRoot, "src-tauri/Info.plist"), "utf8");
  assert.match(infoPlist, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(infoPlist, /<key>NSSpeechRecognitionUsageDescription<\/key>/);

  const entitlements = fs.readFileSync(
    path.join(crateRoot, "src-tauri/Entitlements.plist"),
    "utf8",
  );
  assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);

  for (const configName of ["tauri.macos.conf.json", "tauri.macos.release.conf.json"]) {
    const config = JSON.parse(
      fs.readFileSync(path.join(crateRoot, "src-tauri", configName), "utf8"),
    );
    assert.equal(config.bundle.macOS.hardenedRuntime, true);
    assert.equal(config.bundle.macOS.entitlements, "./Entitlements.plist");
  }
});

test("voice updates preserve structured composer nodes and sending finalizes before cancel", () => {
  const composerSource = fs.readFileSync(
    path.join(crateRoot, "src/pages/chat/components/ChatComposerBar.tsx"),
    "utf8",
  );
  const mentionComposerSource = fs.readFileSync(
    path.join(crateRoot, "src/components/chat/MentionComposer.tsx"),
    "utf8",
  );
  assert.match(composerSource, /setVoiceTranscript\(next\)/);
  assert.doesNotMatch(composerSource, /setText\(next\)/);
  assert.match(mentionComposerSource, /const VOICE_TRANSCRIPT_ATTR = "data-voice-transcript"/);
  assert.match(mentionComposerSource, /segment\.contentEditable = "false"/);
  assert.match(
    composerSource,
    /const handleComposerSend = useCallback\(\(\) => \{\s*cancelActiveVoiceInput\(\);\s*setComposerExpanded\(false\);\s*onSend\(\);/,
  );
});

test("gateway keeps mobile hidden and gives insecure desktop contexts a targeted hint", () => {
  const gatewayComposerSource = fs.readFileSync(
    path.join(repoRoot, "crates/agent-gateway/web/src/pages/chat/ChatComposerBar.tsx"),
    "utf8",
  );
  assert.match(gatewayComposerSource, /const showBuiltInVoiceInput = useMemo\(\(\) => !isMobileClient\(\), \[\]\)/);
  assert.match(
    gatewayComposerSource,
    /enabled: showBuiltInVoiceInput && voiceContextSecure/,
  );
  assert.match(gatewayComposerSource, /t\("chat\.voice\.insecureContext"\)/);
});
