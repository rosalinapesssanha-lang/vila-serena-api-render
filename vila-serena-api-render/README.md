# Vila Serena API (Render)

## Render
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: vazio

## Variáveis de ambiente
Adicione pelo menos uma:
- `GEMINI_API_KEY` = sua chave do Google AI Studio
- `OPENAI_API_KEY` = sua chave da OpenAI

Opcional:
- `GEMINI_MODEL` (padrão `gemini-2.5-flash`)
- `OPENAI_MODEL` (padrão `gpt-4o-mini`)

Rotas:
- `GET /api/health`
- `POST /api/chat` com JSON `{ "provider": "gemini", "system": "...", "message": "..." }`

A chave fica no servidor, nunca no HTML. Não publique o arquivo `.env` nem suas chaves.
