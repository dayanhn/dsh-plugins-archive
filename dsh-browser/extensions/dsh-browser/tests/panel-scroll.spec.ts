// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  isNearBottom,
  SCROLL_STICK_THRESHOLD_PX,
} from '../src/panel/scroll.ts'

describe('isNearBottom', () => {
  // scrollHeight 1000, clientHeight 100 → max scrollTop 900 (distance 0)
  it('is stuck when the bottom is within the threshold', () => {
    expect(isNearBottom(1000, 900, 100)).toBe(true) // at the very bottom
    expect(isNearBottom(1000, 850, 100)).toBe(true) // 50px from bottom
    expect(isNearBottom(1000, 821, 100)).toBe(true) // 79px from bottom
  })

  it('is released at or beyond the threshold', () => {
    expect(isNearBottom(1000, 820, 100)).toBe(false) // exactly 80px
    expect(isNearBottom(1000, 800, 100)).toBe(false) // 100px from bottom
    expect(isNearBottom(1000, 0, 100)).toBe(false) // at the top
  })

  it('stays stuck when content is shorter than the viewport', () => {
    expect(isNearBottom(400, 0, 500)).toBe(true)
  })

  it('keeps the documented threshold', () => {
    expect(SCROLL_STICK_THRESHOLD_PX).toBe(80)
  })
})
