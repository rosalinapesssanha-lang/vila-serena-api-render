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
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeRole(role) {
  const r = String(role || "").toLowerCase().trim();
  if (r === "system" || r === "developer") return "system";
  if (r === "assistant" || r === "model" || r === "npc") return "assistant";
  return "user";
}

function extractChatPayload(body) {
  let system = String(body.system || body.systemPrompt || "").trim();
  let message = String(body.message || body.prompt || "").trim();
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  const history = [];

  // 1) Processa histórico explícito (formato novo)
  for (const item of rawHistory) {
    if (!item || typeof item !== "object") continue;
    const content = String(item.content ?? item.text ?? "").trim();
    if (!content) continue;
    const role = normalizeRole(item.role);
    if (role === "system") {
      if (!system) system = content;
      continue;
    }
    history.push({ role, content });
  }

  // 2) Compatibilidade com formato antigo que envia tudo em `messages`
  if (rawMessages.length > 0) {
    const nonSystem = [];
    for (const m of rawMessages) {
      if (!m || typeof m !== "object") continue;
      const content = String(m.content ?? m.text ?? "").trim();
      if (!content) continue;
      const role = normalizeRole(m.role);
      if (role === "system") {
        if (!system) system = content;
      } else {
        nonSystem.push({ role, content });
      }
    }

    if (!message && nonSystem.length > 0 && nonSystem[nonSystem.length - 1].role === "user") {
      message = nonSystem.pop().content;
    }

    if (history.length === 0 && nonSystem.length > 0) {
      history.push(...nonSystem);
    }
  }

  // Evita duplicar a mensagem atual no final do histórico
  while (history.length > 0) {
    const last = history[history.length - 1];
    if (last.role === "user" && last.content === message) {
      history.pop();
    } else {
      break;
    }
  }

  return {
    system: system || "Você é um morador de Vila Serena.",
    message,
    history: history.slice(-12)
  };
}

async function callGemini(system, history, message) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada no Render");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const contents = history.map(h => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }]
  }));
  contents.push({
    role: "user",
    parts: [{ text: message }]
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 700 }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini respondeu HTTP ${response.status}`);
  }

  return (
    data.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("") || "Não consegui formular uma resposta."
  );
}

async function callOpenAI(system, history, message) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada no Render");
  }

  const messages = [
    { role: "system", content: system },
    ...history.map(h => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content
    })),
    { role: "user", content: message }
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 700
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI respondeu HTTP ${response.status}`);
  }

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
      const { system, message, history } = extractChatPayload(body);
      const requested = String(body.provider || body.mode || "auto").toLowerCase().trim();

      if (!message.trim()) {
        return send(res, 400, { ok: false, error: "Mensagem vazia." });
      }

      let provider = requested;
      if (provider === "auto") {
        provider = GEMINI_API_KEY ? "gemini" : (OPENAI_API_KEY ? "openai" : "");
      }
      if (provider === "google") provider = "gemini";

      if (provider === "local" || provider === "ollama") {
        return send(res, 400, {
          ok: false,
          error: "O modo local/Ollama não é executado nesta hospedagem. Use o motor local do próprio jogo ou um servidor Ollama separado."
        });
      }

      let reply;
      if (provider === "gemini") {
        reply = await callGemini(system, history, message);
      } else if (provider === "openai") {
        reply = await callOpenAI(system, history, message);
      } else {
        return send(res, 503, {
          ok: false,
          error: "Nenhum provedor configurado. Adicione GEMINI_API_KEY ou OPENAI_API_KEY nas variáveis do Render."
        });
      }

      return send(res, 200, {
        ok: true,
        reply,
        response: reply,
        text: reply,
        provider
      });
    } catch (err) {
      return send(res, 500, {
        ok: false,
        error: err.message || "Erro interno da API."
      });
    }
  }

  return send(res, 404, { ok: false, error: "Rota não encontrada." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vila Serena API ouvindo na porta ${PORT}`);
});
