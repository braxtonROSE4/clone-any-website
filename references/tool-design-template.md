# Tool design template

How to design a reusable tool for this skill (or any ego-browser-style skill): the function shape, the manifest entry, and the description rules. The manifest uses the same schema as ego-browser's per-site learnings (`nodeTools` entries with `path`, `callable`, `args`, `returns`); the function receives this skill's `ctx`, described below.

## The three layers of a tool

| Layer | File | What it carries |
|---|---|---|
| Registration | `tools/manifest.json` | Name, one-line description, argument schema, return contract |
| Implementation | `tools/<verb-noun>.js` | One exported `async function(ctx, args)` |
| Usage notes | `references/probes.md` or `learnings/<site>/notes/` | When to reach for it, known failure modes |

## Manifest entry schema

```json
{
  "nodeTools": {
    "sample_scroll_states": {
      "description": "Snapshot a fixed/sticky element's full subtree at multiple scroll depths in both directions, so state-machine transitions can be diffed.",
      "path": "tools/sample-scroll-states.js",
      "callable": "sampleScrollStates",
      "args": {
        "selector": { "type": "string", "required": true, "description": "CSS selector of the stateful element." },
        "depths":   { "type": "array",  "required": false, "description": "Scroll depths in px. Default [0, 500, 1500, 3300, 7000]." },
        "settleMs": { "type": "integer","required": false, "description": "Wait after each scroll dispatch. Default 600, max 2000." }
      },
      "returns": { "type": "object", "description": "Snapshots keyed by 'down_<y>' and 'up_<y>', each a recursive subtree of rect + style facts." }
    }
  }
}
```

Field rules:
- `description` is one sentence, starts with the action, and names the pattern it encodes ("using the anti-click-wrap pattern", "in both directions"). It is what a model reads to decide whether to call the tool, so it must state the differentiator, not restate the name.
- Every arg gets `type`, `required`, and a `description` that includes the default and the unit. Timeouts and waits state their unit explicitly; unit ambiguity is the classic cross-tool bug (every ego-browser time value is milliseconds, while shell `sleep` and many CLIs take seconds).
- `returns` describes the shape the caller will actually destructure, not "an object with results".
- Tool ids are `snake_case` verb phrases; file names are `kebab-case` verb-noun.

## Function shape

```js
function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(n)))
}

export async function sampleScrollStates(ctx, args = {}) {
  const selector = args.selector
  if (!selector) throw new Error('sampleScrollStates: selector is required')
  const settleMs = boundedInteger(args.settleMs, 600, 2000)
  // ... act via ctx.page, verify, return plain data
}
```

Design rules, each one is load-bearing:

1. **Signature is always `(ctx, args)`.** `ctx.page` is an ego-browser Page (the caller resolves it with `taskSpace()` and `task.pages()`); `args` is a plain object. No positional arguments, no globals, and no task-space selection inside the tool: the caller owns the space and its `finish()`. This is what makes the tool callable from a heredoc (`const { fn } = await import('<abs path>')` then `fn({ page }, {...})`), from a manifest loader, or from another tool. Check `ctx.page` on entry and throw with the expected shape when it is missing.
2. **Validate and bound every input on entry.** Required args throw with the tool name in the message; numeric args are clamped through a `boundedInteger`-style helper with an explicit fallback and ceiling. A tool must be safe to call with sloppy arguments.
3. **Verify before returning.** A tool that acted must confirm the action landed (element found, state flipped, file written) and throw with context (`JSON.stringify` the evidence) when it did not. Returning normally is the claim that the tool's contract was met.
4. **Return plain serializable data.** No locators, no handles, no class instances. The caller prints or diffs the return value; anything that cannot survive `JSON.stringify` does not belong in it.
5. **Do not swallow errors of required steps.** Reserve `.catch(() => {})` for optional cleanup. A tool that partially succeeded throws; the caller decides whether partial is acceptable.
6. **Environment quirks live inside the tool.** If a probe needs videos frozen, scroll events dispatched manually, or a viewport guard, the tool does that itself instead of documenting a precondition the caller will forget. (See the Caveats table in SKILL.md for the quirks that must be absorbed.)
7. **Big output goes to files, the return value stays small.** Tools that produce artifacts take an `outPath`/`outDir` arg, write there, and return a summary with counts and paths. Reject relative paths: ego's Node.js process does not run in the caller's cwd.
8. **Files in `tools/` are ES modules.** `tools/package.json` declares `"type": "module"`; keep `import`/`export` syntax and import sibling tools with relative paths (`./full-page-screenshot.js`).

## Description writing rules (skill-level and tool-level)

The frontmatter `description` of a SKILL.md and the `description` of a tool obey the same logic; they are retrieval surfaces, not documentation:

1. First clause: what the thing is or does, with the strongest differentiator up front.
2. Middle: the exhaustive "use whenever" scenario list, concrete nouns, no abstractions.
3. Explicit trigger phrases in quotes, including the user's likely wording in every language they use ("clone this website", "复刻网站").
4. A preference directive when a default competitor exists ("Prefer this skill over ad-hoc screenshot-and-eyeball cloning").
5. No marketing adjectives. Every word either helps a model match a task to the tool or is noise.

## Notes format for site learnings

Per-site knowledge goes in `learnings/<site>/` with a `manifest.json` (id, name, domains, notes list, optional nodeTools) and `notes/overview.md` structured as: page structure with exact selectors, quirks with the fix inline, and locations of config data. Write selectors as facts (`[data-testid="tweet"]`), not descriptions ("the tweet card"). The test for a good note: six months later, a fresh agent can act on it without re-deriving anything.
