import { describe, expect, it } from "bun:test"
import { getMissingSequences } from "./reconcile"

describe("getMissingSequences", () => {
  it("returns empty when all chunks are present", () => {
    expect(getMissingSequences(4, [0, 1, 2, 3, 4])).toEqual([])
  })

  it("returns the missing chunk sequence numbers in ascending order", () => {
    expect(getMissingSequences(7, [0, 1, 3, 4, 6])).toEqual([2, 5, 7])
  })

  it("returns full range when no chunks are acknowledged", () => {
    expect(getMissingSequences(3, [])).toEqual([0, 1, 2, 3])
  })
})
