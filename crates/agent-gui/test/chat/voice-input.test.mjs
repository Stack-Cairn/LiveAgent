import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const voice = loader.loadModule("src/lib/voice/speechRecognition.ts");

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
  assert.equal(voice.mapSpeechRecognitionError("audio-capture"), "chat.voice.noMicrophone");
  assert.equal(voice.mapSpeechRecognitionError("weird"), "chat.voice.failed");
});

test("isMobileClient is false in node test environment", () => {
  assert.equal(voice.isMobileClient(), false);
});
