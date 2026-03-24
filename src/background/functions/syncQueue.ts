/**
 * syncQueue — prevents concurrent autosaves for the same conversation and
 * retries automatically on Notion rate-limit (429) responses.
 *
 * Design:
 *  - One "slot" per convId: if a save for convId X is already running, a
 *    second trigger for X is held until the first finishes (dedup, not fan-out).
 *  - A queued save is always replaced by a newer trigger for the same convId,
 *    so rapid multi-message bursts result in exactly one final save.
 *  - Retries up to 3 times with exponential backoff (1 s, 2 s, 4 s) on 429.
 */

import { Storage } from "@plasmohq/storage"

import { STORAGE_KEYS } from "~utils/consts"
import type { SaveBehavior, SupportedModels } from "~utils/types"

type SaveArgs = {
  convId: string
  model: SupportedModels
  rawHeaders: { name: string; value?: string }[]
  turn: number
  saveBehavior: SaveBehavior
  conflictingPageId?: string
  autoSave: boolean
}

// convId → resolve callback of the currently waiting replacement save
const pending = new Map<string, SaveArgs>()
// convId → true while a save is actively running
const running = new Set<string>()

/**
 * Enqueue an autosave.  Returns the save result or undefined if this call was
 * superseded by a newer trigger before it started executing.
 */
export const enqueueAutoSave = async (
  args: SaveArgs,
  saveFn: (args: SaveArgs) => Promise<any>
): Promise<any> => {
  const { convId } = args

  if (running.has(convId)) {
    // A save is already in flight — register this as the pending replacement.
    // Any previous pending item for the same convId is simply discarded.
    pending.set(convId, args)
    return undefined
  }

  return runWithRetry(args, saveFn)
}

const runWithRetry = async (
  args: SaveArgs,
  saveFn: (args: SaveArgs) => Promise<any>,
  attempt = 0
): Promise<any> => {
  const { convId } = args
  running.add(convId)

  try {
    const result = await saveFn(args)

    // After finishing, check if a newer save was queued while we were running
    const next = pending.get(convId)
    if (next) {
      pending.delete(convId)
      running.delete(convId)
      return runWithRetry(next, saveFn)
    }

    return result
  } catch (err) {
    const isRateLimit =
      err?.status === 429 ||
      err?.code === "rate_limited" ||
      err?.message?.includes("rate")

    if (isRateLimit && attempt < 3) {
      const delay = Math.pow(2, attempt) * 1000
      await new Promise((r) => setTimeout(r, delay))
      // Don't clear running — we're still logically mid-save
      return runWithRetry(args, saveFn, attempt + 1)
    }

    // Unrecoverable: clear lock and propagate
    throw err
  } finally {
    // Only clear the running lock when we're genuinely done (not retrying)
    if (!pending.has(convId)) {
      running.delete(convId)
    }
  }
}
