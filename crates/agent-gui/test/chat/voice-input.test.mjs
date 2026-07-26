import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const voice = loader.loadModule("src/lib/voice/speechRecognition.ts");
const crateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

test("sending cancels recognition before the composer is cleared", () => {
  const composerSource = fs.readFileSync(
    path.join(crateRoot, "src/pages/chat/components/ChatComposerBar.tsx"),
    "utf8",
  );
  assert.match(
    composerSource,
    /const handleComposerSend = useCallback\(\(\) => \{\s*cancelVoiceInput\(\);\s*setComposerExpanded\(false\);\s*onSend\(\);/,
  );
});
