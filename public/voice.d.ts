export type VoiceState = "idle" | "listening" | "error";

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechAlternativeLike {
  transcript: string;
}

export interface SpeechResultLike extends Array<SpeechAlternativeLike> {
  isFinal: boolean;
}

export interface SpeechResultEventLike {
  resultIndex?: number;
  results: ArrayLike<SpeechResultLike>;
}

export interface SpeechErrorEventLike {
  error?: string;
}

export interface VoiceScope {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
}

export interface VoiceInputOptions {
  createRecognition: () => SpeechRecognitionLike | null;
  getText: () => string;
  setText: (text: string) => void;
  onState?: (state: VoiceState, message: string) => void;
  lang?: string;
}

export interface VoiceInput {
  start: () => boolean;
  stop: () => void;
  isListening: () => boolean;
}

export function speechRecognitionCtor(scope?: VoiceScope | null): unknown;

export function createVoiceInput(options: VoiceInputOptions): VoiceInput;
