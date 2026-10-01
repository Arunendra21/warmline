// Diagnostic: calls Groq directly and prints the raw result or the exact error.
// Run:  GROQ_API_KEY=your-key node test-groq.mjs
const key = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
if (!key) {
  console.error("No GROQ_API_KEY set. Run: GROQ_API_KEY=your-key node test-groq.mjs");
  process.exit(1);
}
try {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'Reply with ONLY JSON: {"reply": string, "lang": string, "emotion": string}' },
        { role: "user", content: "hello, I feel a little lonely today" },
      ],
    }),
  });
  console.log("HTTP status:", res.status);
  const text = await res.text();
  console.log("Raw body:\n", text);
} catch (e) {
  console.error("Network/other error:", e.message);
}
