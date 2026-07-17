---
name: extract-terminology
description: Walk a project's documentation and code, extract the domain terminology (abbreviations, service names, product names, domain concepts), and record each term into the paparats glossary via the term_record MCP tool. Deduplicates against existing terms through the built-in similarity gate. Invoke only when the user types /extract-terminology — never auto-trigger.
disable-model-invocation: true
argument-hint: [group] [project]
---

# /extract-terminology — seed the company glossary from docs & code

User-invoked. `$ARGUMENTS` is `[group] [project]` — the Qdrant group and, optionally,
the project (directory basename) to scope extraction to. If project is omitted, cover
the whole group.

The glossary is a paparats knowledge layer (like arch memory) that stores domain
terms — abbreviations, service names, product names, jargon — that dense embeddings
retrieve poorly on their own. It's authored by the agent, not the file indexer. This
skill does the bulk first pass; day-to-day work then keeps it current by recording new
terms as they're encountered.

## Prerequisites

- The paparats coding MCP server must be connected and expose `term_record`,
  `term_search`, `term_list`, `search_docs`, and `search_code`. If `term_record` is
  missing, the terminology layer isn't configured on this server — stop and tell the
  user.

## 1. Establish what's already there

Call `term_list(group, project?)` and keep the returned terms in mind. Everything you
record goes through a duplicate/similar gate, but knowing the existing set avoids
wasted calls and helps you spot terms that need *updating* rather than adding.

## 2. Gather source material

Cast a wide net across BOTH docs and code — terminology lives in both:

- `search_docs` with broad, domain-oriented queries: "overview", "architecture",
  "glossary", "getting started", "concepts", "what is", the product name, each major
  feature area. Read the returned passages.
- `search_code` for names that recur but aren't self-explanatory: service names,
  package names, prominent class/module names, config keys, feature flags,
  environment variables. A name that appears often and isn't a common English word is
  a terminology candidate.
- Look especially at: README files, `docs/` prose, module/service boundaries,
  bounded-context names, and any acronym that appears without expansion.

Scope every query to the given `group` (and `project` when provided).

## 3. Decide what qualifies as a term

Record a term when ALL of these hold:

- It's **domain- or org-specific** — a name, acronym, product, service, or concept a
  newcomer wouldn't know from general knowledge. ("feed-poster", "CLIC", "the stand",
  "bounded context X".)
- It has a **stable, statable meaning** you can define in one or two plain sentences.
- Knowing it would **change how you search or read the code/docs** (disambiguates a
  query, expands an acronym, links a nickname to a real service).

Do NOT record: generic programming terms (mutex, closure, migration), one-off
variable names, obvious English words, or anything you can only guess at. If you're
unsure what a term means, DON'T invent a definition — either dig until you're sure
from the sources, or skip it and note it for the user.

## 4. Record each term

For every qualifying term, call:

```
term_record(
  group,
  term:       "<canonical name, as people actually write it>",
  definition: "<1–2 plain sentences: what it is, what it's for>",
  aliases:    ["<abbreviation>", "<nickname>", "<alt spelling>"],   // optional
  project:    "<project>"        // omit for group-wide terms (most infra/product terms)
)
```

Handle the gate result:

- **created** — new term written. Good.
- **updated** — an existing term with the same name was refreshed.
- **duplicate** / **similar** — a near-identical term already exists (the response
  names it). Do NOT force a second near-duplicate. If your definition is genuinely
  better or more complete, the existing term should be *updated* — re-record with the
  same canonical `term` name so it overwrites in place; otherwise move on.

Prefer **group-wide** scope (omit `project`) for terms that mean the same thing across
the whole org; use `project` scope only for a term that's genuinely specific to one
project.

## 5. Report

Summarise for the user:

```
## Terminology extraction — group <group>[ / project <project>]

Recorded (N):
- <term> — <one-line definition> [created|updated]
...

Skipped near-duplicates (M):
- <term> — matched existing "<name>" (similarity X)

Uncertain / needs a human (K):
- <term> — <why you couldn't define it confidently>
```

Put anything you couldn't define with confidence under "Uncertain" rather than
guessing — a wrong glossary entry is worse than a missing one.

## Notes

- This is a first pass, not a one-shot. Terminology drifts; re-run periodically, and
  record new terms during normal work as you meet them (same `term_record` tool).
- The similarity gate is your safety net against duplicates, but it can't catch a
  *wrong* definition — accuracy is on you.
