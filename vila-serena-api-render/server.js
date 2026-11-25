const http = require("http");

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
// O modelo pode ser alterado no Render sem precisar editar o código.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const MAX_BODY_BYTES = 1_000_000;
const MAX_HISTORY = 12;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 3;

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
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("Corpo da requisição muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase().trim();
  if (value === "system" || value === "developer") return "system";
  if (value === "assistant" || value === "model" || value === "npc") return "assistant";
  return "user";
}

function extractChatPayload(body) {
  let system = String(body.system || body.systemPrompt || "").trim();
  let message = String(body.message || body.prompt || "").trim();
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const history = [];

  for (const item of rawHistory) {
    if (!item || typeof item !== "object") continue;
    const content = String(item.content ?? item.text ?? "").trim();
    if (!content) continue;
    const role = normalizeRole(item.role);
    if (role === "system") {
      if (!system) system = content;
    } else {
      history.push({ role, content });
    }
  }

  if (rawMessages.length) {
    const parsed = [];
    for (const item of rawMessages) {
      if (!item || typeof item !== "object") continue;
      const content = String(item.content ?? item.text ?? "").trim();
      if (!content) continue;
      const role = normalizeRole(item.role);
      if (role === "system") {
        if (!system) system = content;
      } else {
        parsed.push({ role, content });
      }
    }

    if (!message && parsed.length && parsed[parsed.length - 1].role === "user") {
      message = parsed.pop().content;
    }
    if (!history.length && parsed.length) history.push(...parsed);
  }

  while (history.length && history[history.length - 1].role === "user" &&
         history[history.length - 1].content === message) {
    history.pop();
  }

  return {
    system: system || "Você é um morador de Vila Serena. Responda de forma natural e coerente com o contexto da cidade.",
    message,
    history: history.slice(-MAX_HISTORY)
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(status) {
  return status === 408 || status === 429 || status === 500 ||
    status === 502 || status === 503 || status === 504;
}

async function fetchWithRetry(url, options, provider) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { error: { message: raw || "Resposta inválida do provedor." } };
      }

      if (response.ok) return data;

      const message = data.error?.message || `${provider} respondeu HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      if (!isRetryable(response.status) || attempt === MAX_RETRIES) throw error;
      lastError = error;

      const retrySeconds = Number(error.retryAfter);
      const waitMs = Number.isFinite(retrySeconds) && retrySeconds > 0
        ? Math.min(retrySeconds * 1000, 12_000)
        : attempt * 1500;
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      const retryableNetworkError = !error.status &&
        (error.name === "TimeoutError" || error.name === "AbortError" ||
         error.name === "TypeError" || /fetch failed|network|timeout/i.test(error.message || ""));
      if (error.status && !isRetryable(error.status)) throw error;
      if (!retryableNetworkError && !error.status) throw error;
      if (attempt === MAX_RETRIES) throw error;
      await sleep(attempt * 1500);
    }
  }

  throw lastError || new Error(`Falha ao chamar ${provider}.`);
}

async function callGemini(system, history, message) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada no Render.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const contents = history.map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));
  contents.push({ role: "user", parts: [{ text: message }] });

  const data = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 700 }
    })
  }, "Gemini");

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "").join("").trim();
  if (!reply) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason
      ? `Gemini bloqueou a solicitação: ${reason}`
      : "Gemini retornou uma resposta vazia.");
  }
  return reply;
}

async function callGroq(system, history, message) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY não configurada no Render.");

  const messages = [
    { role: "system", content: system },
    ...history.map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content
    })),
    { role: "user", content: message }
  ];

  const data = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 700
    })
  }, "Groq");

  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("Groq retornou uma resposta vazia.");
  }
  return reply.trim();
}

async function callOpenAI(system, history, message) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada no Render.");

  const messages = [
    { role: "system", content: system },
    ...history.map(item => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content
    })),
    { role: "user", content: message }
  ];

  const data = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
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
  }, "OpenAI");

  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("OpenAI retornou uma resposta vazia.");
  }
  return reply.trim();
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
        groq: Boolean(GROQ_API_KEY),
        openai: Boolean(OPENAI_API_KEY)
      },
      models: {
        gemini: GEMINI_MODEL,
        groq: GROQ_MODEL,
        openai: OPENAI_MODEL
      }
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    try {
      const body = await readBody(req);
      const { system, message, history } = extractChatPayload(body);
      const requested = String(body.provider || body.mode || "auto").toLowerCase().trim();

      if (!message) return send(res, 400, { ok: false, error: "Mensagem vazia." });

      let provider = requested === "google" ? "gemini" : requested;
      if (provider === "automatic" || provider === "automático") provider = "auto";
      if (provider === "auto") {
        // No automático, prioriza Groq; Gemini e OpenAI ficam como reservas.
        if (GROQ_API_KEY) provider = "groq";
        else if (GEMINI_API_KEY) provider = "gemini";
        else if (OPENAI_API_KEY) provider = "openai";
        else provider = "";
      }

      if (provider === "local" || provider === "ollama") {
        return send(res, 400, {
          ok: false,
          error: "O modo local/Ollama não é executado nesta hospedagem. Use o motor local do jogo ou um servidor Ollama separado."
        });
      }

      if (provider !== "gemini" && provider !== "groq" && provider !== "openai") {
        return send(res, 503, {
          ok: false,
          error: "Nenhum provedor válido configurado. Adicione GROQ_API_KEY, GEMINI_API_KEY ou OPENAI_API_KEY nas variáveis do Render."
        });
      }

      try {
        const reply = provider === "gemini"
          ? await callGemini(system, history, message)
          : provider === "groq"
            ? await callGroq(system, history, message)
            : await callOpenAI(system, history, message);

        return send(res, 200, {
          ok: true, reply, response: reply, text: reply, provider,
          fallback: false
        });
      } catch (primaryError) {
        // Só troca de provedor no modo automático; modo manual respeita a escolha.
        if (requested !== "auto") throw primaryError;

        const alternatives = ["groq", "gemini", "openai"].filter(name => name !== provider);
        const alternate = alternatives.find(name =>
          name === "groq" ? Boolean(GROQ_API_KEY) :
          name === "gemini" ? Boolean(GEMINI_API_KEY) : Boolean(OPENAI_API_KEY)
        );
        const alternateAvailable = Boolean(alternate);

        if (!alternateAvailable) throw primaryError;

        const reply = alternate === "gemini"
          ? await callGemini(system, history, message)
          : alternate === "groq"
            ? await callGroq(system, history, message)
            : await callOpenAI(system, history, message);

        return send(res, 200, {
          ok: true, reply, response: reply, text: reply,
          provider: alternate, fallback: true,
          note: `${provider} falhou; resposta gerada pelo provedor alternativo.`
        });
      }
    } catch (error) {
      console.error("[Vila Serena API]", error);
      const status = error.status && error.status >= 400 && error.status < 600
        ? error.status
        : 502;
      return send(res, status, {
        ok: false,
        error: error.message || "Erro interno da API."
      });
    }
  }

  return send(res, 404, { ok: false, error: "Rota não encontrada." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vila Serena API ouvindo na porta ${PORT}`);
});
