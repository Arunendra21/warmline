// WarmLine front-end: voice loop, language auto-follow, emotion chips, family summary.
// Uses the browser's free Web Speech API for STT + TTS. Falls back to typing
// when speech recognition is unavailable (e.g. Firefox).

const $ = (id) => document.getElementById(id);
const conversationEl = $("conversation");
const emptyEl = $("empty");
const statusEl = $("status");
const talkBtn = $("talkBtn");
const textInput = $("textInput");
const sendBtn = $("sendBtn");
const langSelect = $("lang");
const familyBtn = $("familyBtn");
const clearBtn = $("clearBtn");
const providerPill = $("provider");

// Full conversation in the shape the API expects.
let messages = [];
let busy = false;

// ---------- provider badge ----------
fetch("/api/health")
  .then((r) => r.json())
  .then((d) => {
    const label = {
      offline: "offline demo brain",
      anthropic: "Claude",
      openai: "OpenAI",
      groq: "Groq (free)",
      gemini: "Gemini (free)",
    }[d.provider] || d.provider;
    providerPill.textContent = label;
  })
  .catch(() => (providerPill.textContent = "offline"));

// ---------- rendering ----------
const EMOTION_EMOJI = {
  happy: "😊",
  content: "🙂",
  neutral: "😐",
  lonely: "🫂",
  anxious: "😟",
  sad: "😢",
};

function setStatus(text) {
  statusEl.textContent = text || "";
}

function removeEmpty() {
  const e = document.getElementById("empty");
  if (e) e.remove();
}

function addBubble(role, text, emotion) {
  removeEmpty();
  removeTyping();
  const b = document.createElement("div");
  b.className = `bubble ${role}`;
  const p = document.createElement("div");
  p.textContent = text;
  b.appendChild(p);
  if (emotion) {
    const meta = document.createElement("div");
    meta.className = "meta";
    const chip = document.createElement("span");
    chip.className = `chip ${emotion}`;
    chip.textContent = `${EMOTION_EMOJI[emotion] || ""} ${emotion}`.trim();
    meta.appendChild(chip);
    b.appendChild(meta);
  }
  conversationEl.appendChild(b);
  b.scrollIntoView({ behavior: "smooth", block: "end" });
  return b;
}

// Animated "…" bubble shown while the companion is thinking.
function showTyping() {
  removeTyping();
  const t = document.createElement("div");
  t.className = "typing";
  t.id = "typing";
  t.innerHTML = "<span></span><span></span><span></span>";
  conversationEl.appendChild(t);
  t.scrollIntoView({ behavior: "smooth", block: "end" });
}
function removeTyping() {
  const t = document.getElementById("typing");
  if (t) t.remove();
}

// ---------- text to speech ----------
function speak(text, lang) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || "en-US";
  const voices = window.speechSynthesis.getVoices();
  const match =
    voices.find((v) => v.lang === u.lang) ||
    voices.find((v) => v.lang && v.lang.startsWith(u.lang.split("-")[0]));
  if (match) u.voice = match;
  u.rate = 0.98;
  u.onstart = () => setStatus("Speaking…");
  u.onend = () => setStatus("");
  window.speechSynthesis.speak(u);
}
// Prime voices (some browsers load them async).
if ("speechSynthesis" in window) window.speechSynthesis.getVoices();

// ---------- send a turn ----------
async function sendUserText(text) {
  const trimmed = text.trim();
  if (!trimmed || busy) return;
  busy = true;
  addBubble("user", trimmed);
  messages.push({ role: "user", content: trimmed });
  setStatus("Thinking…");
  showTyping();
  talkBtn.disabled = true;
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json();
    const reply = data.reply || "I'm here with you.";
    addBubble("agent", reply, data.emotion);
    messages.push({ role: "assistant", content: reply });
    if (data.degraded) {
      setStatus("⚠ AI call failed — using offline brain. " + (data.error || ""));
    } else {
      setStatus("");
    }
    speak(reply, data.lang);
  } catch (e) {
    setStatus("");
    removeTyping();
    addBubble("agent", "Sorry, I had trouble answering just now. Let's try again.", "neutral");
  } finally {
    busy = false;
    talkBtn.disabled = false;
    sendBtn.disabled = false;
    textInput.focus();
  }
}

// ---------- typing input ----------
sendBtn.addEventListener("click", () => {
  const t = textInput.value;
  textInput.value = "";
  sendUserText(t);
});
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const t = textInput.value;
    textInput.value = "";
    sendUserText(t);
  }
});

// ---------- speech recognition (press & hold) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SR) {
  recognition = new SR();
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = "";
  recognition.onstart = () => {
    listening = true;
    finalText = "";
    talkBtn.classList.add("listening");
    talkBtn.textContent = "● Listening… (release)";
    setStatus("Listening…");
  };
  recognition.onresult = (ev) => {
    let interim = "";
    finalText = "";
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    setStatus(`“${(finalText || interim).trim()}”`);
  };
  recognition.onerror = (ev) => {
    setStatus(ev.error === "no-speech" ? "I didn't catch that — try again." : "");
  };
  recognition.onend = () => {
    listening = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎤 Hold to talk";
    const said = finalText.trim();
    if (said) sendUserText(said);
    else setStatus("");
  };

  const startListen = (e) => {
    e.preventDefault();
    if (listening || busy) return;
    recognition.lang = langSelect.value;
    try {
      recognition.start();
    } catch {
      /* already starting */
    }
  };
  const stopListen = (e) => {
    e.preventDefault();
    if (listening) recognition.stop();
  };

  // Mouse + touch press-and-hold.
  talkBtn.addEventListener("mousedown", startListen);
  talkBtn.addEventListener("mouseup", stopListen);
  talkBtn.addEventListener("mouseleave", stopListen);
  talkBtn.addEventListener("touchstart", startListen, { passive: false });
  talkBtn.addEventListener("touchend", stopListen);
} else {
  // No speech recognition: make the button explain itself, typing still works.
  talkBtn.textContent = "🎤 Voice not supported — type below";
  talkBtn.disabled = true;
  talkBtn.style.opacity = "0.6";
}

// ---------- family summary ----------
familyBtn.addEventListener("click", async () => {
  if (!messages.length) {
    alert("Have a short conversation first, then I can summarize it for the family.");
    return;
  }
  setStatus("Preparing family update…");
  try {
    const res = await fetch("/api/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json();
    showSummary(data);
  } catch {
    alert("Could not generate the summary just now.");
  } finally {
    setStatus("");
  }
});

function showSummary(data) {
  const mood = $("modalMood");
  mood.textContent = data.mood || "neutral";
  mood.className = `chip ${data.mood || "neutral"}`;
  const list = $("modalSummary");
  list.innerHTML = "";
  (data.summary || []).forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  });
  const flagsEl = $("modalFlags");
  if (data.flags && data.flags.length) {
    flagsEl.style.display = "block";
    flagsEl.innerHTML =
      "<strong>Worth noting:</strong><ul>" +
      data.flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("") +
      "</ul>";
  } else {
    flagsEl.style.display = "none";
  }
  $("modalBackdrop").classList.add("open");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

$("closeModal").addEventListener("click", () => $("modalBackdrop").classList.remove("open"));
$("modalBackdrop").addEventListener("click", (e) => {
  if (e.target === $("modalBackdrop")) $("modalBackdrop").classList.remove("open");
});

// ---------- new chat ----------
clearBtn.addEventListener("click", () => {
  if (!messages.length) return;
  messages = [];
  conversationEl.innerHTML =
    '<div class="empty" id="empty"><div class="empty-emoji">🌿</div><p>New conversation started.</p><p class="empty-sub">Hold the <strong>Talk</strong> button or type below whenever you\'re ready.</p></div>';
  window.speechSynthesis && window.speechSynthesis.cancel();
  setStatus("");
});
