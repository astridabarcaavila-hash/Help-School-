export default function handler(req, res) {
  const allowed = String(process.env.ALLOWED_ORIGINS || "https://brunocastillo948-ai.github.io")
    .split(",").map(value => value.trim()).filter(Boolean);
  const origin = String(req.headers.origin || "");
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    service: "HELP SCHOOL NOVA",
    configured: Boolean(process.env.GROQ_API_KEY),
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
  });
}
