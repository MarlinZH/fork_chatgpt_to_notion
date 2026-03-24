import type { PlasmoCSConfig } from "plasmo"

import { sendToBackground } from "@plasmohq/messaging"
import { Storage } from "@plasmohq/storage"

import { STORAGE_KEYS } from "~utils/consts"
import { getChatConfig, updateChatConfig } from "~utils/functions"
import type { AutosaveStatus, StoredDatabase } from "~utils/types"

export const config: PlasmoCSConfig = {
  matches: [
    "https://chat.openai.com/*",
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://chat.deepseek.com/*",
    "https://chat.mistral.ai/*"
  ]
}

const storage = new Storage()

// Extract UUID-based chat ID from the last URL path segment.
// Works for all supported platforms:
//   ChatGPT:  /c/{uuid}
//   Claude:   /chat/{uuid}
//   Mistral:  /chat/{uuid}
//   Deepseek: /chat/s/{uuid} (or similar)
const extractChatID = (href: string): string | undefined => {
  try {
    const segments = new URL(href).pathname.split("/").filter(Boolean)
    const last = segments[segments.length - 1]
    return last?.length === 36 ? last : undefined
  } catch {
    return undefined
  }
}

// --- generatingAnswer watcher ---
// Fires on ChatGPT via the background webRequest listener.
// Fires on Claude/Deepseek/Mistral via the MutationObserver below.

storage.watch({
  [STORAGE_KEYS.generatingAnswer]: async ({ newValue, oldValue }) => {
    const chatID = await storage.get<string>(STORAGE_KEYS.chatID)

    if (newValue === true && oldValue === false) {
      if (chatID) updateChatConfig(chatID, { lastSaveStatus: "generating" })
      storage.set(STORAGE_KEYS.autosaveStatus, "generating" as AutosaveStatus)
      return
    }

    if (newValue === false && oldValue === true) {
      if (!chatID) return

      try {
        const chatConfig = await getChatConfig(chatID)
        const globalAutoSave = await storage.get<boolean>(
          STORAGE_KEYS.globalAutoSave
        )

        // Skip if neither per-chat autosave nor global autosave is on
        if (!chatConfig?.enabled && !globalAutoSave) return

        storage.set(STORAGE_KEYS.autosaveStatus, "saving" as AutosaveStatus)

        // Resolve the target database: prefer per-chat config, fall back to
        // the currently selected DB when globalAutoSave is active
        let database: StoredDatabase | null = chatConfig?.database ?? null
        if (!database) {
          const databases = await storage.get<StoredDatabase[]>(
            STORAGE_KEYS.databases
          )
          const selectedDB = await storage.get<number>(STORAGE_KEYS.selectedDB)
          database = databases?.[selectedDB ?? 0] ?? null
        }

        if (!database) throw new Error("No database configured for autosave")

        const { conflictingPageId } = await sendToBackground({
          name: "checkSaveConflit",
          body: { title: document.title, database }
        })

        const res = await sendToBackground({
          name: "save",
          body: {
            saveBehavior: "override",
            conflictingPageId,
            convId: chatID,
            autoSave: true
          }
        })

        storage.set(STORAGE_KEYS.autosaveStatus, "saved" as AutosaveStatus)
        storage.set(STORAGE_KEYS.saveStatus, null)
        updateChatConfig(chatID, {
          lastSaveStatus: res.err ? "error" : "success",
          lastError: res.err
            ? {
                message: res.err.message ?? null,
                code: res.err.code ?? res.err.status ?? null
              }
            : null
        })
      } catch (err) {
        console.error("[autoSave] save failed:", err)
        storage.set(STORAGE_KEYS.autosaveStatus, "error" as AutosaveStatus)
        if (chatID) {
          updateChatConfig(chatID, {
            lastSaveStatus: "error",
            lastError: {
              message:
                err.message ?? JSON.parse(err.body ?? "{}").message ?? null,
              code: err.code ?? err.status ?? null
            }
          })
        }
      }
    }
  }
})

// --- URL / chatID tracking ---

const onload = async () => {
  const chatID = extractChatID(window.location.href)
  await storage.set(STORAGE_KEYS.chatID, chatID ?? null)
}

let oldHref = document.location.href

window.onload = () => {
  onload()
  new MutationObserver((mutations) =>
    mutations.forEach(() => {
      if (oldHref !== document.location.href) {
        oldHref = document.location.href
        onload()
        // Reset so the false→true transition fires cleanly for the next response
        storage.set(STORAGE_KEYS.generatingAnswer, false)
      }
    })
  ).observe(document.querySelector("body")!, { childList: true, subtree: true })
}

// --- MutationObserver-based response-completion detection ---
// ChatGPT's start/stop signals come from background/index.ts via webRequest.
// For all other platforms we watch DOM mutations inside AI response elements.

const hostname = window.location.hostname

const responseSelectors: Partial<Record<string, string>> = {
  "claude.ai": ".font-claude-message",
  "chat.deepseek.com": ".eb23581b",
  "chat.mistral.ai": ".prose.select-text"
}

const responseSelector = responseSelectors[hostname]

if (responseSelector) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let generating = false

  const onResponseActivity = () => {
    if (!generating) {
      generating = true
      storage.set(STORAGE_KEYS.generatingAnswer, true)
    }
    if (debounceTimer) clearTimeout(debounceTimer)
    // Fire "done" after 2 s of DOM silence inside a response element
    debounceTimer = setTimeout(async () => {
      generating = false
      const chatID = await storage.get<string>(STORAGE_KEYS.chatID)
      if (chatID) {
        storage.set(STORAGE_KEYS.generatingAnswer, false)
      }
    }, 2000)
  }

  const responseObserver = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      // characterData mutations target Text nodes; walk up to the parent Element
      const el =
        m.target.nodeType === Node.TEXT_NODE
          ? (m.target as Text).parentElement
          : (m.target as Element)
      return el?.closest?.(responseSelector) != null
    })
    if (relevant) onResponseActivity()
  })

  const startObserver = () =>
    responseObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    })

  if (document.body) {
    startObserver()
  } else {
    window.addEventListener("DOMContentLoaded", startObserver)
  }
}
