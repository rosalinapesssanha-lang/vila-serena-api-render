const http = require("http");

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Corpo da requisição muito grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}

async function callGemini(system, message) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada no Render");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system || "Você é um morador de Vila Serena." }] },
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 700 }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gemini respondeu HTTP ${response.status}`);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "Não consegui formular uma resposta.";
}

async function callOpenAI(system, message) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada no Render");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system || "Você é um morador de Vila Serena." },
        { role: "user", content: message }
      ],
      temperature: 0.8,
      max_tokens: 700
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `OpenAI respondeu HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || "Não consegui formular uma resposta.";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const path = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  if (req.method === "GET" && path === "/api/health") {
    return send(res, 200, {
      ok: true,
      service: "vila-serena-api",
      providers: {
        gemini: Boolean(GEMINI_API_KEY),
        openai: Boolean(OPENAI_API_KEY)
      }
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    try {
      const body = await readBody(req);
      const system = String(body.system || body.systemPrompt || "");
      const message = String(body.message || body.prompt || "");
      const requested = String(body.provider || body.mode || "auto").toLowerCase();
      if (!message.trim()) return send(res, 400, { error: "Mensagem vazia." });

      let provider = requested;
      if (provider === "auto") provider = GEMINI_API_KEY ? "gemini" : (OPENAI_API_KEY ? "openai" : "");
      if (provider === "google") provider = "gemini";
      if (provider === "local" || provider === "ollama") {
        return send(res, 400, { error: "O modo local/Ollama não é executado nesta hospedagem. Use o motor local do próprio jogo ou um servidor Ollama separado." });
      }

      let reply;
      if (provider === "gemini") reply = await callGemini(system, message);
      else if (provider === "openai") reply = await callOpenAI(system, message);
      else return send(res, 503, { error: "Nenhum provedor configurado. Adicione GEMINI_API_KEY ou OPENAI_API_KEY nas variáveis do Render." });

      return send(res, 200, { ok: true, reply, response: reply, provider });
    } catch (err) {
      return send(res, 500, { error: err.message || "Erro interno da API." });
    }
  }

  return send(res, 404, { error: "Rota não encontrada." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vila Serena API ouvindo na porta ${PORT}`);
});
