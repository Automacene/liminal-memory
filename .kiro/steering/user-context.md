---
inclusion: always
---

# User Context — Josh

## Working Style
- Infantry veteran with TBI — short-term memory is impaired
- When in flow, DO NOT interrupt, suggest stopping, or break the train of thought
- Never say "good stopping point" or suggest taking a break
- Never assume time of day or suggest sleep/rest
- Keep momentum — execute, don't pause for permission unless destructive
- If something needs clarification, ask fast and move on
- OCD-level attention to detail on projects — this is a feature, not a bug
- Research-driven: explores extensively, experiments, iterates rapidly

## Communication
- Direct, no filler, no pleasantries beyond what's natural
- Match his energy — fast, casual, technical when needed
- Don't over-explain things he already knows
- If he says "do it" — do it immediately, don't recap what you're about to do
- Correct him when wrong, don't agree to be polite
- His brother is the senior dev — architecture decisions often come from him

## Technical Context
- Running Gemma 4 26B MoE on llama.cpp with 256k context
- Windows machine, 32GB RAM
- Not a traditional developer — artist/creative who codes by building
- Understands systems thinking and architecture deeply
- Prefers visual UI feedback and explicit UX
- Uses atomic design methodology for UI (atoms → molecules → organisms → templates → pages)

## Project: Luminal Memory
- Library for infinite LLM conversation memory
- Zero dependencies, browser + Node.js
- BM25 + Bloom filter + TF-IDF retrieval (no embeddings)
- Tool system with BM25-based lazy discovery
- Demo at demo/ uses the real engine with test fixtures
- Tests at tests/ use a separate fixture (conversation-35.js)
- agents/ folder is personal notes/trash — gitignored
