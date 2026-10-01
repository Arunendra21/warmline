// WarmLine — zero-dependency Node server.
// Serves the static UI and exposes /api/chat and /api/summary.
// Works with Anthropic or OpenAI when a key is set; otherwise a built-in
// offline companion keeps the full pipeline demoable with no setup.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY; // free, no credit card: https://console.groq.com
const GEMINI_KEY = process.env.GEMINI_API_KEY; // free: https://aistudio.google.com/apikey
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// Free providers (Groq, Gemini) are preferred before the paid ones.
const PROVIDER = GROQ_KEY
  ? "groq"
  : GEMINI_KEY
  ? "gemini"
  : ANTHROPIC_KEY
  ? "anthropic"
  : OPENAI_KEY
  ? "openai"
  : "offline";

const MODEL_LABEL = {
  groq: GROQ_MODEL,
  gemini: GEMINI_MODEL,
  anthropic: ANTHROPIC_MODEL,
  openai: OPENAI_MODEL,
  offline: "offline",
}[PROVIDER];

const COMPANION_SYSTEM = `You are WarmLine, a warm, patient AI companion for an elderly person who may be lonely.
Rules:
- Detect the language the user is speaking and ALWAYS reply in that same language.
- Speak in short, clear, kind sentences, as if talking aloud to someone you care about.
- Be emotionally attuned: acknowledge how they feel, then ask one gentle follow-up question.
- Never rush, never lecture, never give medical advice beyond "it may be worth telling your doctor or family".
- Keep every reply to 1-3 short sentences suitable for text-to-speech.
Respond with ONLY a JSON object, no markdown, no code fence:
{"reply": string, "lang": BCP-47 language code e.g. "en-US"|"ko-KR"|"hi-IN"|"es-ES", "emotion": one of "happy"|"content"|"neutral"|"lonely"|"anxious"|"sad"}`;

const SUMMARY_SYSTEM = `You write a brief daily update for the family/caregiver of an elderly person,
based on their conversation with an AI companion. Be warm but factual.
Respond with ONLY a JSON object, no markdown, no code fence:
{"mood": one of "happy"|"content"|"neutral"|"lonely"|"anxious"|"sad",
 "summary": array of up to 3 short plain-English sentences,
 "flags": array of short strings for any health or safety concerns mentioned (empty array if none)}`;

// ---------- LLM providers ----------

async function callAnthropic(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

// Groq and Gemini both expose an OpenAI-compatible chat endpoint, so one caller
// covers OpenAI, Groq (free), and Gemini (free) — only the base URL/key/model differ.
async function callOpenAICompatible(baseUrl, key, model, system, messages) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 400,
      // Ask for guaranteed-valid JSON; Groq/OpenAI/Gemini all support this.
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Returns the raw model text so callers can recover gracefully if it isn't JSON.
async function llmRaw(system, messages) {
  switch (PROVIDER) {
    case "anthropic":
      return callAnthropic(system, messages);
    case "openai":
      return callOpenAICompatible("https://api.openai.com/v1", OPENAI_KEY, OPENAI_MODEL, system, messages);
    case "groq":
      return callOpenAICompatible("https://api.groq.com/openai/v1", GROQ_KEY, GROQ_MODEL, system, messages);
    case "gemini":
      return callOpenAICompatible("https://generativelanguage.googleapis.com/v1beta/openai", GEMINI_KEY, GEMINI_MODEL, system, messages);
    default:
      throw new Error("no LLM provider configured");
  }
}

// Models sometimes wrap JSON in prose or a code fence; recover the object.
function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------- Offline fallback companion ----------

function detectLang(text) {
  if (/[가-힣]/.test(text)) return "ko-KR"; // Hangul
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN"; // Devanagari
  if (/[áéíóúñ¿¡]/i.test(text)) return "es-ES";
  return "en-US";
}

function detectEmotion(text) {
  const t = text.toLowerCase();
  const has = (words) => words.some((w) => t.includes(w));
  if (has(["lonely", "alone", "miss ", "외로", "혼자", "अकेला", "solo", "sola"]))
    return "lonely";
  if (has(["sad", "cry", "슬프", "눈물", "उदास", "triste"])) return "sad";
  if (has(["worried", "scared", "anxious", "afraid", "걱정", "불안", "चिंता", "preocup"]))
    return "anxious";
  if (has(["happy", "good", "great", "wonderful", "glad", "행복", "좋", "खुश", "अच्छा", "feliz", "bien"]))
    return "happy";
  return "content";
}

const OFFLINE_REPLIES = {
  "en-US": {
    lonely: "I hear you, and I'm right here with you. Who have you been thinking about today?",
    sad: "I'm sorry you're feeling low. Do you want to tell me what's on your heart?",
    anxious: "That sounds worrying. Take a slow breath with me — what's troubling you most?",
    happy: "That's wonderful to hear! What made today feel good?",
    content: "Thank you for sharing that with me. What else is on your mind today?",
  },
  "ko-KR": {
    lonely: "제가 여기 함께 있어요. 오늘은 누구 생각이 많이 나셨어요?",
    sad: "마음이 힘드셨군요. 무슨 일이 있으셨는지 말씀해 주시겠어요?",
    anxious: "많이 걱정되시겠어요. 저랑 천천히 숨 한 번 쉬어요. 무엇이 가장 걱정되세요?",
    happy: "정말 좋은 소식이네요! 오늘 무엇이 그렇게 좋으셨어요?",
    content: "이야기해 주셔서 감사해요. 오늘 또 어떤 생각이 드세요?",
  },
  "hi-IN": {
    lonely: "मैं यहीं आपके साथ हूँ। आज आप किसके बारे में सोच रहे थे?",
    sad: "आपका मन दुखी है, यह सुनकर दुख हुआ। क्या आप बताना चाहेंगे कि क्या हुआ?",
    anxious: "यह चिंता की बात लगती है। मेरे साथ एक गहरी साँस लीजिए — सबसे ज़्यादा किस बात की चिंता है?",
    happy: "यह तो बहुत अच्छी बात है! आज क्या अच्छा हुआ?",
    content: "मुझसे साझा करने के लिए धन्यवाद। आज और क्या मन में है?",
  },
  "es-ES": {
    lonely: "Estoy aquí contigo. ¿En quién has estado pensando hoy?",
    sad: "Siento que te sientas así. ¿Quieres contarme qué tienes en el corazón?",
    anxious: "Eso suena preocupante. Respira despacio conmigo, ¿qué es lo que más te inquieta?",
    happy: "¡Qué maravilla escuchar eso! ¿Qué hizo que hoy fuera bueno?",
    content: "Gracias por compartirlo conmigo. ¿Qué más tienes en mente hoy?",
  },
};

function offlineChat(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser?.content ?? "";
  const lang = detectLang(text);
  const emotion = detectEmotion(text);
  const table = OFFLINE_REPLIES[lang] || OFFLINE_REPLIES["en-US"];
  const reply = table[emotion] || table.content;
  return { reply, lang, emotion };
}

function offlineSummary(messages) {
  const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
  const joined = userTurns.join(" ");
  const mood = userTurns.length ? detectEmotion(joined) : "neutral";
  const summary = [];
  if (userTurns.length)
    summary.push(`Had a conversation of ${userTurns.length} exchange(s) today.`);
  summary.push(
    mood === "happy" || mood === "content"
      ? "Seemed in good spirits overall."
      : `Seemed ${mood} during the conversation — a check-in call may be appreciated.`
  );
  const flags = [];
  const low = joined.toLowerCase();
  if (/(pain|hurt|dizzy|fell|fall|아프|통증|दर्द|dolor)/.test(low))
    flags.push("Mentioned physical discomfort — consider following up.");
  if (/(medicine|medication|pill|약|दवा|medicina)/.test(low))
    flags.push("Medication was mentioned.");
  return { mood, summary: summary.slice(0, 3), flags };
}

// ---------- HTTP helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  // Prevent path traversal: resolve and confirm it stays within PUBLIC_DIR.
  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// ---------- Routes ----------

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return sendJson(res, 200, { ok: true, provider: PROVIDER });
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const { messages } = JSON.parse((await readBody(req)) || "{}");
      if (!Array.isArray(messages)) return sendJson(res, 400, { error: "messages[] required" });
      if (PROVIDER === "offline") return sendJson(res, 200, offlineChat(messages));
      try {
        const raw = await llmRaw(COMPANION_SYSTEM, messages);
        const out = parseJsonLoose(raw);
        if (out && out.reply) {
          return sendJson(res, 200, {
            reply: out.reply,
            lang: out.lang || detectLang(out.reply),
            emotion: out.emotion || detectEmotion(out.reply),
          });
        }
        // Model replied but not as JSON — use its text directly rather than
        // falling back to the canned offline line.
        const text = (raw || "").trim();
        if (text) {
          return sendJson(res, 200, {
            reply: text,
            lang: detectLang(text),
            emotion: detectEmotion(messages[messages.length - 1]?.content || text),
          });
        }
        throw new Error("empty model output");
      } catch (e) {
        // Only reach here if the API call itself failed (bad key, dead model…).
        console.error("chat fallback:", e.message);
        return sendJson(res, 200, { ...offlineChat(messages), degraded: true, error: e.message });
      }
    }

    if (req.method === "POST" && req.url === "/api/summary") {
      const { messages } = JSON.parse((await readBody(req)) || "{}");
      if (!Array.isArray(messages)) return sendJson(res, 400, { error: "messages[] required" });
      if (PROVIDER === "offline") return sendJson(res, 200, offlineSummary(messages));
      try {
        const transcript = messages
          .map((m) => `${m.role === "user" ? "Senior" : "Companion"}: ${m.content}`)
          .join("\n");
        const raw = await llmRaw(SUMMARY_SYSTEM, [
          { role: "user", content: `Conversation:\n${transcript}` },
        ]);
        const out = parseJsonLoose(raw);
        if (!out || !Array.isArray(out.summary)) throw new Error("bad model output");
        return sendJson(res, 200, {
          mood: out.mood || "neutral",
          summary: out.summary.slice(0, 3),
          flags: Array.isArray(out.flags) ? out.flags : [],
        });
      } catch (e) {
        console.error("summary fallback:", e.message);
        return sendJson(res, 200, { ...offlineSummary(messages), degraded: true });
      }
    }

    if (req.method === "GET") return serveStatic(req, res);

    res.writeHead(405).end("Method not allowed");
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n  WarmLine running at  http://localhost:${PORT}`);
  console.log(`  LLM provider:        ${PROVIDER}${PROVIDER === "offline" ? "  (set GROQ_API_KEY for a FREE smart brain — https://console.groq.com)" : ` (${MODEL_LABEL})`}\n`);
});
