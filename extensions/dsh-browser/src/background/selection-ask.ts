/**
 * Selection-ask context menu: right-click on selected page text to send that
 * selection — and only that selection — to dsh. Two entry points:
 *
 * - "explain" fires immediately: the selection plus its page URL becomes a
 *   prompt in the current (or a fresh) browser session.
 * - "ask with selection" stashes the selection in `chrome.storage.session`;
 *   the panel shows it as a quoted chip above the composer, and the user's
 *   next question carries it as a reference block.
 *
 * Both flows bypass the tab-binding / whole-page snapshot preparation the
 * panel's normal prompt path performs: the selection itself is the context,
 * so no page content is read or injected.
 *
 * @module
 */

import { getUiLocale, type UiLocale } from '../i18n.ts'

/** Hard cap on selection text carried into one prompt, in characters. */
export const SELECTION_MAX_CHARS = 20_000

/** `chrome.storage.session` key holding the stashed selection awaiting a question. */
export const PENDING_SELECTION_KEY = 'dshPendingSelection'

/** Context-menu item ids (one extension's context menu space). */
export const MENU_EXPLAIN_ID = 'dsh-ask-selection-explain'
export const MENU_WITH_SELECTION_ID = 'dsh-ask-selection-with-selection'

/** A selection stashed by "ask with selection", awaiting the user's question. */
export interface PendingSelection {
  text: string
  url: string
  savedAt: number
}

/**
 * Normalize and cap a raw context-menu selection.
 * @param raw - `info.selectionText`, possibly padded or containing CRLF.
 * @param max - character cap, defaults to {@link SELECTION_MAX_CHARS}.
 * @returns the trimmed, capped selection; empty string when nothing remains.
 */
export function truncateSelection(raw: string, max: number = SELECTION_MAX_CHARS): string {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[selection truncated at ${max} characters]`
}

/** Wrap one selection as a quoted block for a prompt. */
export function quoteBlock(text: string): string {
  return `"""\n${text}\n"""`
}

/**
 * Prompt for the immediate explain flow.
 * @param selection - capped selection text.
 * @param url - the page the selection came from.
 * @param locale - UI locale for the instruction wording.
 * @returns the full user prompt.
 */
export function buildExplainPrompt(selection: string, url: string, locale: UiLocale): string {
  return locale === 'zh'
    ? `请解释下面这段文字（来自 ${url}）：\n\n${quoteBlock(selection)}`
    : `Please explain the following passage (from ${url}):\n\n${quoteBlock(selection)}`
}

/**
 * Prompt for the "ask with selection" flow: the user's question first, the
 * quoted reference below a separator.
 * @param question - the user's own question text.
 * @param selection - capped selection text.
 * @param url - the page the selection came from.
 * @param locale - UI locale for the reference label.
 * @returns the full user prompt.
 */
export function buildQuotedPrompt(question: string, selection: string, url: string, locale: UiLocale): string {
  const label = locale === 'zh'
    ? `参考选文（来自 ${url}）：`
    : `Reference selection (from ${url}):`
  return `${question}\n\n---\n${label}\n${quoteBlock(selection)}`
}

/**
 * The context-menu click payload. `windowId` exists in Chrome's runtime API;
 * the installed type declarations predate it, so name the fields we read.
 */
interface SelectionClickData {
  menuItemId: string | number
  selectionText?: string
  pageUrl?: string
  windowId?: number
}

/** Background capabilities the menu wiring needs. */
export interface SelectionAskDeps {
  /** Open (or focus) the assistant side panel for one window. */
  openPanel: (windowId: number) => void
  /** Resolve true once the bridge is connected, false when the timeout elapses. */
  waitBridgeConnected: (timeoutMs: number) => Promise<boolean>
  /** The session the panel used most recently, if any. */
  recentSessionId: () => string | null
  /** Remember a session as this browser's current one. */
  rememberSession: (sessionId: string) => void
  /** One unary gateway RPC straight to the bridge (no tab-binding preparation). */
  rpc: (method: string, payload: unknown) => Promise<unknown>
  /** Post a message to every open panel port; no-op when none are open. */
  broadcastToPanel: (message: unknown) => void
  /** Show a user notification (title, body). */
  notify: (title: string, message: string) => void
}

/**
 * Register the two selection context-menu items and wire their clicks.
 * Idempotent across service-worker restarts (removeAll first — the menu
 * space is this extension's own).
 * @param deps - background-provided capabilities.
 */
export function initSelectionAsk(deps: SelectionAskDeps): void {
  const titleFor = (zh: string, en: string): string => (getUiLocale() === 'zh' ? zh : en)
  void Promise.resolve(chrome.contextMenus.removeAll()).then(() => {
    chrome.contextMenus.create({ id: MENU_EXPLAIN_ID, title: titleFor('用 dsh 解释选中文本', 'Explain selection with dsh'), contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU_WITH_SELECTION_ID, title: titleFor('带着选中文本问 dsh', 'Ask dsh about this selection'), contexts: ['selection'] })
  })

  chrome.contextMenus.onClicked.addListener((info) => {
    const data: SelectionClickData = info
    const selection = truncateSelection(String(data.selectionText ?? ''))
    if (selection === '') return
    const url = String(data.pageUrl ?? '')
    const locale = getUiLocale()

    if (data.menuItemId === MENU_WITH_SELECTION_ID) {
      const pending: PendingSelection = { text: selection, url, savedAt: Date.now() }
      void chrome.storage.session.set({ [PENDING_SELECTION_KEY]: pending }).then(() => {
        if (data.windowId !== undefined) deps.openPanel(data.windowId)
        deps.broadcastToPanel({ type: 'selection-pending' })
      })
      return
    }

    if (data.menuItemId !== MENU_EXPLAIN_ID) return
    if (data.windowId !== undefined) deps.openPanel(data.windowId)
    void deps.waitBridgeConnected(20_000).then(async (connected) => {
      if (!connected) {
        deps.notify(
          titleFor('dsh 未连接', 'dsh not connected'),
          locale === 'zh'
            ? '无法连接到 dsh，请确认 dsh web 正在运行后重试。'
            : 'Could not reach dsh. Make sure `dsh web` is running, then try again.',
        )
        return
      }
      let sessionId = deps.recentSessionId()
      if (sessionId === null) {
        const created = await deps.rpc('session.create', {}) as { sessionId: string }
        sessionId = created.sessionId
        deps.rememberSession(sessionId)
      }
      await deps.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildExplainPrompt(selection, url, locale) }],
      })
      deps.broadcastToPanel({ type: 'selection-ask', kind: 'explain', sessionId })
    }).catch((error: unknown) => {
      deps.notify(
        titleFor('发送到 dsh 失败', 'Failed to ask dsh'),
        error instanceof Error ? error.message : String(error),
      )
    })
  })
}
