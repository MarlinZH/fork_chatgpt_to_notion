# CLAUDE.md — AI Assistant Guide for chat-to-notion

This file provides context for AI assistants working in this codebase.

## Project Overview

**chat-to-notion** is a Chrome browser extension (Manifest V3) that saves conversations from AI chat platforms (ChatGPT, Claude, Deepseek, Mistral) to Notion databases. Built with the [Plasmo](https://www.plasmo.com/) extension framework.

- **Version:** 2.0.1
- **Package manager:** pnpm
- **Framework:** Plasmo 0.90.3 (MV3)
- **Language:** TypeScript + React 18

---

## Development Commands

```bash
pnpm dev       # Start development server with hot reload
pnpm build     # Production build → build/chrome-mv3-prod/
pnpm package   # Zip for distribution → build/chrome-mv3-prod.zip
```

There is **no test suite**. Testing is done manually in the Chrome browser.

---

## Repository Structure

```
src/
├── api/                  # Top-level API functions (orchestration layer)
├── background/
│   ├── index.ts          # Service worker entry point
│   ├── functions/        # Business logic (auth, save, refresh, history)
│   └── messages/         # Plasmo message handlers (background ↔ popup)
├── common/               # Shared SVG icon components
├── config/               # SDK initialization (Notion client, HTML→MD converter)
├── contents/             # Content scripts injected into LLM pages
│   ├── chatgpt.tsx
│   ├── claude.tsx
│   ├── deepseek.tsx
│   ├── mistral.tsx
│   ├── popup.tsx         # Floating popup overlay
│   ├── auth.ts
│   ├── autoSave.ts
│   └── fetchFullPage.ts
├── hooks/                # React hooks (storage, debounce, tags)
├── lib/                  # Utility libraries
├── models/               # LLM-specific implementations
│   ├── chatgpt/
│   ├── claude/
│   ├── deepseek/
│   └── mistral/
├── popup/                # React popup UI components (12 popups)
├── tabs/                 # Extension tab pages (e.g., update.tsx)
└── utils/
    ├── consts.ts         # Storage keys and constants
    ├── functions/        # Helper utilities (markdown, Notion blocks, i18n)
    └── types/            # TypeScript type definitions
assets/
└── locales/              # i18n translations (en, fr, ja)
```

---

## Architecture

### Extension Parts (Plasmo MV3)

| Part | Location | Role |
|------|----------|------|
| Service Worker | `src/background/index.ts` | OAuth, web request interception, header capture |
| Content Scripts | `src/contents/{platform}.tsx` | Inject pin icons into LLM pages, track conversations |
| Popup | `src/popup/` | React UI for saving, settings, databases |
| Options Page | `options/` | Extension settings page |

### Multi-LLM Architecture

Each supported LLM has its own folder under `src/models/{model}/` with:
- `api/` — Platform-specific API calls
- `functions/` — Conversation parsing
- `types/` — Response type definitions

Central dispatch in `src/api/` and `src/utils/functions/llms.ts` routes to model-specific handlers based on a `SupportedModels` union type:

```typescript
type SupportedModels = "chatgpt" | "deepseek" | "mistral" | "claude"
```

**To add a new LLM:** create `src/models/{new-llm}/`, add content script at `src/contents/{new-llm}.tsx`, and add to the union type and dispatch functions.

### Data Flow: Save a Conversation

1. User clicks pin icon (injected by content script)
2. Content script sends message to background service worker
3. Background fetches conversation via LLM API (using captured auth headers)
4. Response is parsed → HTML → Markdown → Notion blocks
5. Notion API creates/appends page in selected database
6. Chunking handles Notion's 100-block limit

### Message Passing

Uses `@plasmohq/messaging`. Background message handlers are in `src/background/messages/`; each is a default export of `PlasmoMessaging.MessageHandler`.

### Storage

Uses `@plasmohq/storage` with two areas:

| Area | Contents |
|------|----------|
| `local` | User settings, databases, token IDs (persistent) |
| `session` | Auth tokens, cache headers (cleared on tab close, encrypted) |

All storage keys are defined in `src/utils/consts.ts`. Sensitive keys (`"token"`, `"cacheHeaders"`) use encrypted session storage.

### Content Script Pattern

```typescript
// Plasmo content script boilerplate
export const config: PlasmoCSConfig = { matches: ["https://chatgpt.com/*"] }
export const getInlineAnchorList: PlasmoGetInlineAnchorList = async () => { ... }
export const render: PlasmoRender<PlasmoCSUIJSXContainer> = ({ anchor, createRootContainer }) => { ... }
```

Each platform uses unique DOM selectors to find AI responses (e.g., `.markdown` for ChatGPT, `.font-claude-message` for Claude).

---

## Key Conventions

### Import Aliases

The `~` prefix resolves to `src/`:

```typescript
import { STORAGE_KEYS } from "~utils/consts"
import { saveChat } from "~api/saveChat"
```

### Naming Conventions

- Components: `PascalCase` (`SavePopup`, `IndexPopup`)
- Functions: `camelCase` (`getConversation`, `parseSave`)
- Constants: `UPPER_SNAKE_CASE` (`STORAGE_KEYS`)
- SVG icons: descriptive names (`pin.tsx`, `trash.tsx`, `gear.tsx`)

### Code Style (Prettier)

- No semicolons
- 2-space indentation, 80-char line width
- Trailing commas: none
- Import order (enforced by Plasmo plugin): `@plasmohq` → `~` → relative

### Error Handling

```typescript
// Standard error type
type Error = { code?: string; message?: string; status?: number }
// Always catch and surface to ErrorPopup component
```

### Content Processing Pipeline

```
LLM HTML response
  → node-html-markdown  (HTML → Markdown)
  → @tryfabric/martian  (Markdown → Notion blocks)
  → chunking (100-block batches for Notion API limit)
```

Special handling exists for: KaTeX math, code interpreter output, DALL-E images, canvas/artifact blocks, tables (edge cases).

### Internationalization

```typescript
import { i18n } from "~utils/functions"
const label = i18n("save_button_label")  // looks up assets/locales/{lang}/messages.json
```

Supported languages: `en`, `fr`, `ja`.

---

## Authentication Flow

1. User clicks extension → redirects to Notion OAuth
2. Notion OAuth returns `workspace_id` & `user_id` in URL params
3. Background service fetches long-lived token from custom server (`server` branch)
4. Token stored in **encrypted session storage**
5. Token used for all subsequent Notion API calls

LLM auth tokens are captured via `chrome.webRequest` listeners that intercept API requests made by the LLM web apps.

---

## Premium Features

Gated via storage flags `isPremium` and `activeTrial`:
- **Autosave** — Automatically save conversations on completion
- **History saving** — Save conversation history (partial support)
- **Trial mode** — Free trial available before purchase

---

## Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | Extends Plasmo base config; `~` path alias; strictNullChecks |
| `tailwind.config.js` | JIT mode; custom color `main: "#333"`; dynamic class safelist |
| `.prettierrc.cjs` | Prettier + Plasmo import sort plugin |
| `postcss.config.js` | Tailwind + Autoprefixer |
| `.github/workflows/submit.yml` | CI: build + publish to Chrome Web Store via BPP |

---

## Supported LLMs

| Platform | Content Script | Models Folder | History Support |
|----------|---------------|---------------|-----------------|
| ChatGPT | `contents/chatgpt.tsx` | `models/chatgpt/` | Yes |
| Claude | `contents/claude.tsx` | `models/claude/` | Yes |
| Deepseek | `contents/deepseek.tsx` | `models/deepseek/` | Yes |
| Mistral | `contents/mistral.tsx` | `models/mistral/` | No |

**Planned (not yet implemented):** Perplexity, Grok

---

## CI/CD

- Triggered manually via `workflow_dispatch` in GitHub Actions
- Installs with pnpm, builds, packages, then publishes via `@plasmohq/bpp`
- Requires secrets for browser store authentication
- No automated tests in CI pipeline
