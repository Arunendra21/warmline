# WarmLine — a multilingual, emotion-aware AI voice companion

A small working prototype of a **voice-based AI companion for senior care**: an elderly
person talks to it in their own language, it replies warmly in that same language, reads
the emotional tone of each turn, and generates a short **daily update for the family**.

Built as a focused demo of the pattern behind real-world companion agents — natural voice,
multilingual by default, emotionally attuned, and connected back to the people who care.

## Why it's built this way

The interesting problem in a voice companion isn't the LLM call — it's the **round trip
feeling human**: low latency, the right language in and out, and graceful degradation so
the person is *never* left talking to a dead line.

- **Latency / responsiveness.** Speech-to-text and text-to-speech run **in the browser**
  via the Web Speech API, so there's no audio upload round-trip — only the short text turn
  goes to the server. Recognition streams interim results so the user sees themselves being
  heard immediately.
- **Language auto-follow.** The user picks the language they'll *speak* (STT needs a hint),
  but the model detects the spoken language and replies in kind, returning a BCP-47 `lang`
  tag that selects a matching TTS voice. Speak Korean, hear Korean back.
- **Never breaks.** Every model call degrades to a built-in offline companion if the API
  key is missing or the request fails, so the demo always responds. The front-end also
  falls back from voice to typing on browsers without speech recognition.
- **Structured output.** The model returns strict JSON (`reply`, `lang`, `emotion`), parsed
  defensively (`parseJsonLoose`) so a stray code-fence or sentence of prose can't crash a turn.

## Run it

Requires **Node 18+** (uses the built-in `fetch`). **No `npm install` — zero dependencies.**

```bash
cd warmline
node server.js
# open http://localhost:3000
```

It runs immediately with the offline companion brain. For real intelligence, add a key:

```bash
# Claude
ANTHROPIC_API_KEY=sk-ant-... node server.js
# or OpenAI
OPENAI_API_KEY=sk-... node server.js
```

(Copy `.env.example` for reference. Use Chrome/Edge for voice — Safari works, Firefox lacks
speech recognition and will use the typing fallback.)

## Try this in a demo

1. Set the language to **한국어**, hold the mic, say something a little down ("요즘 좀 외로워요").
   → It replies gently in Korean and tags the mood **lonely**.
2. Switch to **English**, say "I slept well, my grandson called me today."
   → Warm English reply, mood **happy**.
3. Hit **Family view** → a 3-line caregiver summary with an overall mood and any health flags.

## What I'd build next

- **Streaming TTS + barge-in** (let the person interrupt mid-sentence) for true real-time feel.
- **Telephony** (Twilio) so it works on a regular phone — most seniors aren't on a browser.
- **Memory across days** so it remembers "how did your knee feel after yesterday?"
- **Caregiver dashboard** with trend lines on mood and flagged concerns.

## Layout

```
warmline/
├── server.js          # zero-dep Node server + LLM providers + offline fallback
├── public/
│   ├── index.html     # senior-friendly UI (large type, high contrast, big targets)
│   ├── styles.css
│   └── app.js         # voice loop, language auto-follow, emotion chips, summary
├── .env.example
└── README.md
```
