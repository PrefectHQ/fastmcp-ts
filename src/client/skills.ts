import { z } from 'zod'
import type { BlobResourceContents, TextResourceContents } from './results.js'

/** The SEP-2640 Skills extension identifier, advertised under `capabilities.extensions`. */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'

/** The URI prefix every file of a skill shares: its `SKILL.md` URI without `SKILL.md`. */
export function skillDirectory(skillUri: string): string {
  return skillUri.slice(0, -'SKILL.md'.length)
}

const SkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
})

const SkillFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
})

const SkillEntrySchema = z
  .object({
    uri: z.string().endsWith('/SKILL.md'),
    frontmatter: SkillFrontmatterSchema,
    resources: z.union([z.array(SkillResourceSchema), z.literal('dynamic')]),
  })
  .refine(
    ({ uri, resources }) =>
      resources === 'dynamic' ||
      resources.every((resource) => resource.uri.startsWith(skillDirectory(uri))),
    'every skill file must be inside the skill directory',
  )

export const ListSkillsResultSchema = z.object({
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
})

export const GetSkillResultSchema = z.object({
  skill: SkillEntrySchema,
})

/** One file in a skill's static manifest, with the size and digest its bytes must match. */
export type SkillResource = z.infer<typeof SkillResourceSchema>

/** The skill's `SKILL.md` frontmatter. `name` and `description` are required; other keys pass through. */
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/**
 * A SEP-2640 skill entry from `skills/list` or `skills/get`. `resources` lists every
 * file in the skill, or is `'dynamic'` when the server cannot enumerate them.
 */
export type SkillEntry = z.infer<typeof SkillEntrySchema>

/** A skill read by `Client.readSkill()`: its entry and the verified bytes of each file. */
export interface SkillContents {
  entry: SkillEntry
  /** File bytes keyed by path relative to the skill directory, e.g. `SKILL.md` or `scripts/check.py`. */
  files: Map<string, Uint8Array>
}

/** Decodes one `resources/read` result into the file's bytes, or throws if they break the entry's size or digest. */
export async function parseSkillFile(
  record: SkillResource,
  contents: ReadonlyArray<TextResourceContents | BlobResourceContents>,
): Promise<Uint8Array> {
  if (contents.length !== 1) {
    throw new Error(`Expected one content block for ${record.uri}, got ${contents.length}`)
  }
  const content = contents[0]
  const bytes =
    'text' in content
      ? new TextEncoder().encode(content.text)
      : Uint8Array.from(atob(content.blob), (char) => char.charCodeAt(0))
  if (bytes.length !== record.size) {
    throw new Error(`Skill file ${record.uri} is ${bytes.length} bytes; the entry promised ${record.size}`)
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (`sha256:${hex}` !== record.digest) {
    throw new Error(`Skill file ${record.uri} does not match its entry's digest`)
  }
  return bytes
}
