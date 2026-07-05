export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
  }
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        messages: req.body.messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const message = (data && data.error && data.error.message) || `Anthropic API error (${resp.status})`;
      return res.status(resp.status).json({ error: message });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
