import { distance } from 'fastest-levenshtein'

const SUGGESTION_THRESHOLD = 4

export function findSuggestions(query: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ name: c, dist: distance(query, c) }))
    .filter(({ dist }) => dist <= SUGGESTION_THRESHOLD)
    .sort((a, b) => a.dist - b.dist)
    .map(({ name }) => name)
}

export function closestMatch(query: string, candidates: string[]): string | undefined {
  const suggestions = findSuggestions(query, candidates)
  return suggestions[0]
}
