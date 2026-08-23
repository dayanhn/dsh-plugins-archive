// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildExplainPrompt,
  buildQuotedPrompt,
  PENDING_EXPLAIN_KEY,
  PENDING_SELECTION_KEY,
  quoteBlock,
  SELECTION_MAX_CHARS,
  truncateSelection,
} from '../src/background/selection-ask.ts'

describe('truncateSelection', () => {
  it('trims padding and normalizes CRLF', () => {
    expect(truncateSelection('  hello\r\nworld  ')).toBe('hello\nworld')
  })

  it('returns empty for whitespace-only input', () => {
    expect(truncateSelection('   \n  ')).toBe('')
  })

  it('caps at the limit and marks the cut', () => {
    const text = 'a'.repeat(SELECTION_MAX_CHARS + 50)
    const out = truncateSelection(text)
    expect(out.length).toBeLessThan(text.length)
    expect(out.endsWith(`…[selection truncated at ${SELECTION_MAX_CHARS} characters]`)).toBe(true)
  })

  it('honors an explicit smaller cap', () => {
    expect(truncateSelection('abcdefghij', 4)).toBe('abcd\n…[selection truncated at 4 characters]')
  })
})

describe('quoteBlock', () => {
  it('wraps the selection in triple quotes', () => {
    expect(quoteBlock('abc')).toBe('"""\nabc\n"""')
  })
})

describe('buildExplainPrompt', () => {
  it('includes the url and quoted selection (zh)', () => {
    const prompt = buildExplainPrompt('hello', 'https://example.com/x', 'zh')
    expect(prompt).toContain('https://example.com/x')
    expect(prompt).toContain('"""\nhello\n"""')
    expect(prompt).toContain('解释')
  })

  it('includes the url and quoted selection (en)', () => {
    const prompt = buildExplainPrompt('hello', 'https://example.com/x', 'en')
    expect(prompt).toContain('https://example.com/x')
    expect(prompt).toContain('"""\nhello\n"""')
    expect(prompt.toLowerCase()).toContain('explain')
  })
})

describe('buildQuotedPrompt', () => {
  it('puts the question first, then the labeled quote (zh)', () => {
    const prompt = buildQuotedPrompt('这是什么？', 'abc', 'https://e.com/p', 'zh')
    expect(prompt.startsWith('这是什么？')).toBe(true)
    expect(prompt).toContain('https://e.com/p')
    expect(prompt).toContain('"""\nabc\n"""')
    expect(prompt.indexOf('参考选文')).toBeGreaterThan(prompt.indexOf('这是什么？'))
  })

  it('puts the question first, then the labeled quote (en)', () => {
    const prompt = buildQuotedPrompt('what is this?', 'abc', 'https://e.com/p', 'en')
    expect(prompt.startsWith('what is this?')).toBe(true)
    expect(prompt).toContain('Reference selection')
    expect(prompt).toContain('"""\nabc\n"""')
  })
})

describe('constants', () => {
  it('uses a distinct storage key for the stashed selection', () => {
    expect(PENDING_SELECTION_KEY).toBe('dshPendingSelection')
  })

  it('uses a distinct storage key for the stashed explain prompt', () => {
    expect(PENDING_EXPLAIN_KEY).toBe('dshPendingExplain')
  })
})
