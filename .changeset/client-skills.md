---
"@prefecthq/fastmcp-ts": minor
---

Add client support for the MCP Skills extension (SEP-2640). Opt in by adding `SKILLS_EXTENSION_ID` to `capabilities.extensions`, then call `listSkills()`, `getSkill(uri)`, and `readSkill(uri)` on a modern (2026-07-28) connection. `readSkill()` checks every file against the skill's entry. `supportsSkills()` reports whether the connection can use the extension. Built on the SDK's `SkillsClient`.
