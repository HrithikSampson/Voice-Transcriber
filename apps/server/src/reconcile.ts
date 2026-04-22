export const getMissingSequences = (
  expectedThroughSequence: number,
  ackedSequences: number[]
) => {
  const existing = new Set(ackedSequences)
  const missing: number[] = []
  for (let sequence = 0; sequence <= expectedThroughSequence; sequence++) {
    if (!existing.has(sequence)) {
      missing.push(sequence)
    }
  }
  return missing
}
