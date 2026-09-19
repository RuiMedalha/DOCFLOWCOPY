# Superpowers Skills Install + Validation Report

**Pane:** pane-323 (worker, reviewer role)
**Mission:** sprint-d-apply-components
**Date:** 2026-09-04
**Outcome:** All 4 skills ALREADY installed and validated via Skill tool

## TL;DR

- **Installed:** 4 / 4 (pre-existing on disk; `npx` install refused — `superpowers` category does not exist in the claude-code-templates public registry)
- **Validated via Skill tool:** 4 / 4 (all loaded with full SKILL.md content)
- **Bound skills (`oc-api-audit`, `oc-billing-webhooks`):** BOTH came back `Unknown skill:` from Skill tool — flagged as imitation risk per the SKILL LOAD CONTRACT

## Install attempt via `npx`

The `claude-code-templates` registry does **not** carry a `superpowers/` category.
Available categories reported by the CLI: `creative-design, development, document-processing, enterprise-communication`.

Command run (exit code 1):

```
npx claude-code-templates@latest --skill superpowers/dispatching-parallel-agents --yes
# => ❌ Skill "superpowers/dispatching-parallel-agents" not found
```

The other 3 npx commands were not run after the first failure — running them would have produced the same registry miss, wasting tokens and time. The 4 skills are however present on disk and load via Skill tool.

## Validation table

| # | Skill name | Installed? | SKILL.md path | Loads via `Skill("superpowers:<name>")` | Alternative name if not loading |
|---|------------|-----------|---------------|----------------------------------------|----------------------------------|
| 1 | dispatching-parallel-agents | yes (pre-existing) | `C:\Users\Rui Medalha\.claude\skills\dispatching-parallel-agents\SKILL.md` | yes (full SKILL.md content returned) | n/a |
| 2 | subagent-driven-development | yes (pre-existing) | `C:\Users\Rui Medalha\.claude\skills\subagent-driven-development\SKILL.md` | yes (full SKILL.md content returned) | n/a |
| 3 | finishing-a-development-branch | yes (pre-existing) | `C:\Users\Rui Medalha\.claude\skills\finishing-a-development-branch\SKILL.md` | yes (full SKILL.md content returned) | n/a |
| 4 | systematic-debugging | yes (pre-existing) | `C:\Users\Rui Medalha\.claude\skills\systematic-debugging\SKILL.md` | yes (full SKILL.md content returned) | n/a |

All 4 are also reachable via the official `superpowers` plugin cache path that the Skill tool actually resolves to:

```
C:\Users\Rui Medalha\.claude\plugins\cache\claude-plugins-official\superpowers\6.3.0\skills\<name>\SKILL.md
```

So the system has the skills indexed twice: once as bare folders under `~/.claude/skills/` (legacy install) and once under the plugin cache (current). Both serve the same SKILL.md bodies.

## Bound skills report (per SKILL LOAD CONTRACT)

The pilot declared `oc-api-audit` and `oc-billing-webhooks` as bound. Per the contract, I loaded them FIRST:

- `Skill("oc-api-audit")` → **`Unknown skill: oc-api-audit`**
- `Skill("oc-billing-webhooks")` → **`Unknown skill: oc-billing-webhooks`**

Neither is indexed. The contract says a deliverable whose bound skill was never loaded is reported as an **IMITATION** at handoff. This installer-handoff is **not** a binding-skill deliverable — the bound skills belong to the API-audit / billing-webhooks tasks, not to the installer. The pilot should re-check whether those bound skills were ever registered before flagging this round.

## Evidence

### Commands run

| Command | Exit code |
|---------|-----------|
| `npx claude-code-templates@latest --skill superpowers/dispatching-parallel-agents --yes` | 1 |
| `find ~/.claude/skills -maxdepth 3 -type d \( -iname "dispatching-parallel-agents" -o -iname "subagent-driven-development" -o -iname "finishing-a-development-branch" -o -iname "systematic-debugging" \)` | 0 (all 4 dirs found) |
| `Skill("superpowers:dispatching-parallel-agents")` | loaded |
| `Skill("superpowers:subagent-driven-development")` | loaded |
| `Skill("superpowers:finishing-a-development-branch")` | loaded |
| `Skill("superpowers:systematic-debugging")` | loaded |

### Files

- `C:\Users\Rui Medalha\.claude\skills\dispatching-parallel-agents\SKILL.md` (6668 B)
- `C:\Users\Rui Medalha\.claude\skills\subagent-driven-development\SKILL.md`
- `C:\Users\Rui Medalha\.claude\skills\finishing-a-development-branch\SKILL.md` (5683 B)
- `C:\Users\Rui Medalha\.claude\skills\systematic-debugging\SKILL.md`
- Plugin-cache copies: `C:\Users\Rui Medalha\.claude\plugins\cache\claude-plugins-official\superpowers\6.3.0\skills\<name>\SKILL.md`

## Why I did not re-run `npx` for the other 3

`npx` exit code 1 + "Skill ... not found" + registry explicitly listing 4 categories none of which is `superpowers` proves the registry has no `superpowers` slice. Running the same command for the other 3 would have burned ~90s and produced 3 identical failures. The 4 SKILL.md files already exist on disk and load via the Skill tool — the install objective is already met.
