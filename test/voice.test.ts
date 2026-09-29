import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, startTestServer } from "./helpers.js";
import type {
  SpeechErrorEventLike,
  SpeechRecognitionLike,
  SpeechResultEventLike,
  SpeechResultLike,
  VoiceInput,
  VoiceState,
} from "../public/voice.js";

interface VoiceModule {
  createVoiceInput: (options: unknown) => VoiceInput;
  voiceMode: (scope?: unknown) => "hold" | "toggle";
  speechRecognitionCtor: (scope?: unknown) => unknown;
}

let cached: VoiceModule | null = null;

async function loadVoice(): Promise<VoiceModule> {
  if (cached === null) {
    cached = (await import(pathToFileURL(join(REPO_ROOT, "public", "voice.js")).href)) as VoiceModule;
  }
  return cached;
}

class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechResultEventLike) => void) | null = null;
  onerror: ((event: SpeechErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
    this.onend?.();
  }

  abort(): void {
    this.stopped = true;
    this.onend?.();
  }
}

function makeResult(transcript: string, isFinal: boolean): SpeechResultLike {
  const result = [{ transcript }] as SpeechResultLike;
  result.isFinal = isFinal;
  return result;
}

function transcriptEvent(
  entries: Array<{ transcript: string; final?: boolean }>,
): SpeechResultEventLike {
  return {
    resultIndex: 0,
    results: entries.map((entry) => makeResult(entry.transcript, entry.final === true)),
  };
}

interface Recorder {
  voice: VoiceInput;
  recognition: FakeRecognition;
  text: () => string;
  states: Array<[VoiceState, string]>;
}

async function recorder(options: { initialText?: string; recognition?: FakeRecognition } = {}): Promise<Recorder> {
  const { createVoiceInput } = await loadVoice();
  const recognition = options.recognition ?? new FakeRecognition();
  let text = options.initialText ?? "";
  const states: Array<[VoiceState, string]> = [];
  const voice = createVoiceInput({
    createRecognition: () => recognition,
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
    onState: (state: VoiceState, message: string) => states.push([state, message]),
  });
  return { voice, recognition, text: () => text, states };
}

test("speechRecognitionCtor detects the Web Speech API and its webkit alias", async () => {
  const { speechRecognitionCtor } = await loadVoice();
  function Recognition(): void {}

  assert.equal(speechRecognitionCtor({}), null);
  assert.equal(speechRecognitionCtor({ SpeechRecognition: "yes" }), null);
  assert.equal(speechRecognitionCtor({ SpeechRecognition: Recognition }), Recognition);
  assert.equal(speechRecognitionCtor({ webkitSpeechRecognition: Recognition }), Recognition);
});

test("voiceMode uses tap-to-toggle on iOS and hold-to-talk elsewhere", async () => {
  const { voiceMode } = await loadVoice();
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

  assert.equal(voiceMode({ navigator: { userAgent: iphone, platform: "iPhone", maxTouchPoints: 5 } }), "toggle");
  assert.equal(voiceMode({ navigator: { userAgent: mac, platform: "MacIntel", maxTouchPoints: 5 } }), "toggle");
  assert.equal(voiceMode({ navigator: { userAgent: mac, platform: "MacIntel", maxTouchPoints: 0 } }), "hold");
  assert.equal(voiceMode({ navigator: { userAgent: chrome, platform: "Win32", maxTouchPoints: 0 } }), "hold");
  assert.equal(voiceMode({}), "hold");
});

test("a recognition that cannot be created reports an error", async () => {
  const { createVoiceInput } = await loadVoice();
  const states: Array<[VoiceState, string]> = [];
  const voice = createVoiceInput({
    createRecognition: () => null,
    getText: () => "",
    setText: () => {},
    onState: (state: VoiceState, message: string) => states.push([state, message]),
  });

  assert.equal(voice.start(), false);
  assert.equal(voice.isListening(), false);
  assert.deepEqual(states.map(([state]) => state), ["error"]);
});

test("recognition keeps listening across pauses until it is stopped", async () => {
  const rec = await recorder();
  rec.voice.start();
  assert.equal(rec.recognition.continuous, true);

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "Tell the builder to pause.", final: true }]));
  assert.equal(rec.voice.isListening(), true);
  rec.recognition.onresult?.(
    transcriptEvent([
      { transcript: "Tell the builder to pause.", final: true },
      { transcript: "Then rebase onto main.", final: true },
    ]),
  );
  rec.voice.stop();
  assert.equal(rec.text(), "Tell the builder to pause. Then rebase onto main.");
  assert.equal(rec.voice.isListening(), false);
});

test("the final transcript is appended to the composer text", async () => {
  const rec = await recorder({ initialText: "existing note" });
  assert.equal(rec.voice.start(), true);
  assert.equal(rec.recognition.interimResults, true);
  assert.equal(rec.states[0]?.[0], "listening");

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "hello world", final: true }]));
  assert.equal(rec.text(), "existing note hello world");

  rec.recognition.onend?.();
  assert.equal(rec.text(), "existing note hello world");
  assert.equal(rec.voice.isListening(), false);
});

test("interim results appear while speaking and give way to the final transcript", async () => {
  const rec = await recorder({ initialText: "note" });
  rec.voice.start();

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "hel", final: false }]));
  assert.equal(rec.text(), "note hel");

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "hello", final: false }]));
  assert.equal(rec.text(), "note hello");

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "hello", final: true }]));
  assert.equal(rec.text(), "note hello");

  rec.recognition.onend?.();
  assert.equal(rec.text(), "note hello");
});

test("successive final utterances accumulate in order", async () => {
  const rec = await recorder({ initialText: "base" });
  rec.voice.start();

  rec.recognition.onresult?.(transcriptEvent([{ transcript: "one", final: true }]));
  rec.recognition.onresult?.(
    transcriptEvent([
      { transcript: "one", final: true },
      { transcript: "two", final: true },
    ]),
  );
  assert.equal(rec.text(), "base one two");
});

test("stop ends listening and keeps the finalized transcript", async () => {
  const rec = await recorder({ initialText: "note" });
  rec.voice.start();
  rec.recognition.onresult?.(transcriptEvent([{ transcript: "done", final: true }]));

  rec.voice.stop();
  assert.equal(rec.recognition.stopped, true);
  assert.equal(rec.voice.isListening(), false);
  assert.equal(rec.text(), "note done");
});

test("microphone and speech errors surface a short message and keep final text", async () => {
  const cases: Array<[string, RegExp]> = [
    ["not-allowed", /blocked/i],
    ["no-speech", /hear/i],
    ["audio-capture", /microphone/i],
    ["unknown-code", /failed/i],
  ];

  for (const [code, pattern] of cases) {
    const rec = await recorder({ initialText: "kept" });
    rec.voice.start();
    rec.recognition.onresult?.(transcriptEvent([{ transcript: "partial", final: true }]));
    rec.recognition.onerror?.({ error: code });

    const failure = rec.states.find(([state]) => state === "error");
    assert.ok(failure, `expected an error state for ${code}`);
    assert.match(String(failure?.[1]), pattern);
    assert.equal(rec.voice.isListening(), false);
    assert.equal(rec.text(), "kept partial");
  }
});

test("an aborted recognition returns to idle without an error", async () => {
  const rec = await recorder();
  rec.voice.start();
  rec.recognition.onerror?.({ error: "aborted" });
  assert.equal(rec.states.at(-1)?.[0], "idle");
  assert.equal(rec.voice.isListening(), false);
});

test("a recognition that fails to construct reports an error and does not throw", async () => {
  const { createVoiceInput } = await loadVoice();
  const states: Array<[VoiceState, string]> = [];
  const voice = createVoiceInput({
    createRecognition: () => {
      throw new Error("boom");
    },
    getText: () => "",
    setText: () => {},
    onState: (state: VoiceState, message: string) => states.push([state, message]),
  });

  assert.equal(voice.start(), false);
  assert.equal(states[0]?.[0], "error");
  assert.match(String(states[0]?.[1]), /boom/);
});

test("an error raised while starting is not overwritten by the listening state", async () => {
  const { createVoiceInput } = await loadVoice();
  const recognition = new FakeRecognition();
  recognition.start = () => {
    recognition.started = true;
    recognition.onerror?.({ error: "not-allowed" });
  };
  const states: Array<[VoiceState, string]> = [];
  let text = "";
  const voice = createVoiceInput({
    createRecognition: () => recognition,
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
    onState: (state: VoiceState, message: string) => states.push([state, message]),
  });

  assert.equal(voice.start(), false);
  assert.equal(states.at(-1)?.[0], "error");
  assert.match(String(states.at(-1)?.[1]), /blocked/i);
  assert.equal(voice.isListening(), false);
});

test("voice input never writes anywhere but the composer text", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("voice input must not use the network");
  }) as typeof fetch;

  try {
    const rec = await recorder({ initialText: "note" });
    rec.voice.start();
    rec.recognition.onresult?.(transcriptEvent([{ transcript: "spoken", final: true }]));
    rec.recognition.onend?.();
    assert.equal(rec.text(), "note spoken");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("spoken text is queued through the existing /api/note path", async () => {
  const rec = await recorder();
  rec.voice.start();
  rec.recognition.onresult?.(transcriptEvent([{ transcript: "check the west gate", final: true }]));
  rec.recognition.onend?.();
  const text = rec.text();
  assert.equal(text, "check the west gate");

  const server = await startTestServer({ token: "t" });
  try {
    const response = await fetch(`${server.url}/api/note`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text, requestId: "voice-req" }),
    });
    assert.equal(response.status, 200);
    const stored = readFileSync(join(server.home, "state", "notes", "voice-req"), "utf8");
    assert.equal(stored, "check the west gate");
  } finally {
    await server.close();
  }
});
