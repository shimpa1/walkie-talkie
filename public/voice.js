const ERROR_MESSAGES = {
  "not-allowed": "Microphone access is blocked. Allow it in your browser, or type your instruction.",
  "service-not-allowed": "Speech recognition is blocked. Allow it in your browser, or type your instruction.",
  "audio-capture": "No microphone was found. Check your device and try again, or type your instruction.",
  "no-speech": "I did not hear anything. Try again, or type your instruction.",
  network: "Speech recognition needs a network connection. Try again, or type your instruction.",
};

function defaultScope() {
  return typeof window !== "undefined" ? window : null;
}

export function voiceSupported(scope) {
  return speechRecognitionCtor(scope) !== null;
}

export function speechRecognitionCtor(scope) {
  const target = scope || defaultScope();
  if (!target) return null;
  const ctor = target.SpeechRecognition || target.webkitSpeechRecognition;
  return typeof ctor === "function" ? ctor : null;
}

function describeError(error) {
  if (error && typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

function cleanChunk(chunk) {
  return typeof chunk === "string" ? chunk.trim() : "";
}

function appendChunk(current, chunk) {
  const piece = cleanChunk(chunk);
  if (!piece) return current;
  return current ? `${current} ${piece}` : piece;
}

function composeText(baseText, finalText, interimText) {
  return [baseText, finalText, interimText]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" ");
}

export function createVoiceInput(options) {
  const opts = options || {};
  const supported = typeof opts.supported === "function" ? opts.supported : () => false;
  const createRecognition =
    typeof opts.createRecognition === "function" ? opts.createRecognition : () => null;
  const getText = typeof opts.getText === "function" ? opts.getText : () => "";
  const setText = typeof opts.setText === "function" ? opts.setText : () => {};
  const onState = typeof opts.onState === "function" ? opts.onState : () => {};
  const lang = typeof opts.lang === "string" && opts.lang ? opts.lang : "";

  let active = null;
  let listening = false;
  let baseText = "";
  let committedText = "";

  function emit(state, message) {
    onState(state, message || "");
  }

  function commit() {
    setText(composeText(baseText, committedText, ""));
  }

  function handleResult(event) {
    const results = (event && event.results) || [];
    let finalText = "";
    let interimText = "";
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const alternative = result ? result[0] : null;
      const chunk = alternative ? alternative.transcript : "";
      if (result && result.isFinal) finalText = appendChunk(finalText, chunk);
      else interimText = appendChunk(interimText, chunk);
    }
    committedText = finalText;
    setText(composeText(baseText, committedText, interimText));
  }

  function handleError(event) {
    const code = event && event.error ? String(event.error) : "unknown";
    const wasListening = listening;
    listening = false;
    active = null;
    if (wasListening) commit();
    if (code === "aborted") {
      emit("idle", "");
      return;
    }
    emit("error", ERROR_MESSAGES[code] || `Voice input failed (${code}). Type your instruction instead.`);
  }

  function handleEnd() {
    if (!listening) return;
    listening = false;
    active = null;
    commit();
    emit("idle", "");
  }

  function start() {
    if (listening) return true;
    if (!supported()) {
      emit("unsupported", "Voice input is not supported in this browser. Type your instruction instead.");
      return false;
    }
    let recognition;
    try {
      recognition = createRecognition();
    } catch (error) {
      emit("error", `Could not start voice input: ${describeError(error)}`);
      return false;
    }
    if (!recognition) {
      emit("unsupported", "Voice input is not supported in this browser. Type your instruction instead.");
      return false;
    }
    baseText = typeof getText() === "string" ? getText() : "";
    committedText = "";
    active = recognition;
    listening = true;
    try {
      if (lang) recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = handleResult;
      recognition.onerror = handleError;
      recognition.onend = handleEnd;
      recognition.start();
    } catch (error) {
      active = null;
      listening = false;
      emit("error", `Could not start voice input: ${describeError(error)}`);
      return false;
    }
    if (!listening) return false;
    emit("listening", "");
    return true;
  }

  function stop() {
    if (!active) return;
    const recognition = active;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        active = null;
        listening = false;
        commit();
        emit("idle", "");
      }
    }
  }

  function isListening() {
    return listening;
  }

  return { start, stop, isListening };
}
