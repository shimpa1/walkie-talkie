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

function appendFinal(current, chunk) {
  const piece = cleanChunk(chunk);
  if (!piece) return current;
  if (!current) return piece;
  if (piece === current || current.endsWith(` ${piece}`)) return current;
  if (piece.startsWith(`${current} `)) return piece;
  return `${current} ${piece}`;
}

function composeText(baseText, finalText, interimText) {
  return [baseText, finalText, interimText]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" ");
}

export function createVoiceInput(options) {
  const opts = options || {};
  const createRecognition =
    typeof opts.createRecognition === "function" ? opts.createRecognition : () => null;
  const getText = typeof opts.getText === "function" ? opts.getText : () => "";
  const setText = typeof opts.setText === "function" ? opts.setText : () => {};
  const onState = typeof opts.onState === "function" ? opts.onState : () => {};
  const lang = typeof opts.lang === "string" && opts.lang ? opts.lang : "";

  let active = null;
  let held = false;
  let baseText = "";
  let committedText = "";
  let sessionText = "";

  function emit(state, message) {
    onState(state, message || "");
  }

  function commit() {
    setText(composeText(baseText, committedText, ""));
  }

  function foldSession() {
    committedText = appendChunk(committedText, sessionText);
    sessionText = "";
  }

  function finish(state, message) {
    held = false;
    active = null;
    foldSession();
    commit();
    emit(state, message);
  }

  function handleResult(recognition, event) {
    if (recognition !== active) return;
    const results = (event && event.results) || [];
    let finalText = "";
    let interimText = "";
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const alternative = result ? result[0] : null;
      const chunk = alternative ? alternative.transcript : "";
      if (result && result.isFinal) finalText = appendFinal(finalText, chunk);
      else interimText = appendChunk(interimText, chunk);
    }
    sessionText = finalText;
    setText(composeText(baseText, appendChunk(committedText, sessionText), interimText));
  }

  function handleError(recognition, event) {
    if (recognition !== active) return;
    const code = event && event.error ? String(event.error) : "unknown";
    if (held && (code === "no-speech" || code === "aborted")) return;
    if (code === "aborted") {
      finish("idle", "");
      return;
    }
    finish("error", ERROR_MESSAGES[code] || `Voice input failed (${code}). Type your instruction instead.`);
  }

  function handleEnd(recognition) {
    if (recognition !== active) return;
    foldSession();
    if (held) {
      listen();
      return;
    }
    finish("idle", "");
  }

  function listen() {
    let recognition;
    try {
      recognition = createRecognition();
    } catch (error) {
      finish("error", `Could not start voice input: ${describeError(error)}`);
      return;
    }
    if (!recognition) {
      finish("error", "Could not start voice input. Type your instruction instead.");
      return;
    }
    active = recognition;
    try {
      if (lang) recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (event) => handleResult(recognition, event);
      recognition.onerror = (event) => handleError(recognition, event);
      recognition.onend = () => handleEnd(recognition);
      recognition.start();
    } catch (error) {
      if (recognition === active) finish("error", `Could not start voice input: ${describeError(error)}`);
    }
  }

  function start() {
    if (held) return true;
    held = true;
    if (active) return true;
    baseText = typeof getText() === "string" ? getText() : "";
    committedText = "";
    sessionText = "";
    listen();
    if (!held) return false;
    emit("listening", "");
    return true;
  }

  function stop() {
    held = false;
    if (!active) return;
    const recognition = active;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        if (recognition === active) finish("idle", "");
      }
    }
  }

  function isListening() {
    return held || active !== null;
  }

  return { start, stop, isListening };
}
