# Newsdesk — Todo

## Pending

- [ ] **Tool-based AI** — refactor `src/ai.js` to use Claude tool use (function calling) instead of JSON-in-prompt; removes the fallback regex parser
- [ ] **DeepSeek API** — experiment with DeepSeek as an alternative to Claude Haiku for classification; compare cost, latency, output quality
- [ ] **HeatWave RAG** — use Oracle MySQL HeatWave embeddings + vector search to store and query article embeddings; replace the flat "last 20 feedback" context approach
- [ ] **Source discovery agent** — agentic pipeline that reads an article, finds referenced/outbound sources, evaluates them, and surfaces suggestions to the user in the UI
