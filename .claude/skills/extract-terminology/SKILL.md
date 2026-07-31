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

Work from **prose**, not from code identifiers:

- `search_docs` with broad, domain-oriented queries: "overview", "architecture",
  "glossary", "getting started", "concepts", "what is", the product name, each major
  feature area. Read the returned passages.
- `search_code` only to *confirm or refine* a term you already met in prose — e.g. to
  check what a service actually does before defining it. Not as a source of new terms.
- Look especially at: `docs/` prose, product and feature descriptions, module/service
  boundaries, bounded-context names, and any acronym that appears without expansion.

Do NOT mine code for terminology: config keys, feature flags, environment variables,
class and package names. `search_code` already finds those by name — a glossary entry
adds nothing, and every extra term costs precision (see below).

Scope every query to the given `group` (and `project` when provided).

### Why the glossary must stay small

Matched terms are shown alongside `search_docs` results, gated by a similarity floor
(`GLOSSARY_MIN_SCORE`, currently 0.55). That floor was calibrated on a glossary with a
single term, and the on-term / off-term score bands **overlap** — measured worst
on-term 0.595 against worst off-term 0.629. So there is no threshold that admits every
real match while rejecting every wrong one.

The practical consequence: each term you add is another chance to attach an unrelated
definition to someone's question. That is survivable — the terms sit beside the
results and no longer distort retrieval — but a glossary padded with identifiers turns
every search into a wall of irrelevant definitions.

Prefer 20 terms a newcomer genuinely could not guess over 200 that merely exist.

## 3. Decide what qualifies as a term

Record a term when ALL of these hold:

- It's **domain- or org-specific** — a name, acronym, product, service, or concept a
  newcomer wouldn't know from general knowledge. ("feed-poster", "CLIC", "the stand",
  "bounded context X".)
- It has a **stable, statable meaning** you can define in one or two plain sentences.
- Knowing it would **change how you search or read the code/docs** (disambiguates a
  query, expands an acronym, links a nickname to a real service).

Do NOT record: generic programming terms (mutex, closure, migration), one-off
variable names, obvious English words, config keys, environment variables, feature
flags, class or package names, or anything you can only guess at. If you're unsure
what a term means, DON'T invent a definition — either dig until you're sure from the
sources, or skip it and note it for the user.

One more test, because of the overlap described above: **would this term's definition
be useful to see attached to a search that merely mentions it in passing?** A term
whose definition only helps someone already asking about it directly is a weak
candidate — it will fire on unrelated questions more often than it helps.

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

Keep the definition to **one or two sentences**. It is rendered verbatim into the
context of anyone whose `search_docs` query matches the term, so length is a running
cost paid on every match — not a one-off. State what the thing is and what it's for;
leave the details to the docs the search returns.

Aliases are the cheap part: they only help the term be *found*, they don't lengthen
what gets shown. List the abbreviations and nicknames people actually type.

Handle the gate result:

- **created** — new term written. Good.
- **updated** — an existing term with the same name was refreshed.
- **duplicate** / **similar** — a near-identical term already exists (the response
  names it). Do NOT force a second near-duplicate. If your definition is genuinely
  better or more complete, the existing term should be *updated* — re-record with the
  same canonical `term` name so it overwrites in place; otherwise move on.
- **an error** — the call now fails loudly rather than degrading. Previously a store
  failure was swallowed and read as "no such term yet", which silently wrote a
  duplicate and reset the original's `createdAt`. If a call errors, stop and report it
  instead of retrying blind — the gate is not protecting you while the store is
  unreachable.

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
- Prefer reading the documentation **from a local checkout** when one is available.
  `search_docs` returns excerpts (a passage plus neighbours), which is right for
  answering a question but lossy for surveying vocabulary — a glossary page or an
  overview is exactly the kind of document you want whole. Use the search tools to
  locate material and the filesystem to read it.
- After a bulk run, the similarity floor that decides which terms get shown
  (`GLOSSARY_MIN_SCORE` in `mcp-handler.ts`) is worth re-measuring: it was calibrated
  against a single-term glossary, so its false-positive rate on a populated one is
  unknown. Score a set of on-topic and off-topic queries against the real glossary and
  check where the bands actually separate.
