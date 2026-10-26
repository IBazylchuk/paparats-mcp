# Architectural memory and the glossary

Code search tells the agent what the code does. Architectural memory keeps why: the
components, the decisions behind them and the lessons learned. The coding agent writes it
as it works and reads it before changes that cross components, so the next session knows
what this one learned.

## Three kinds of card

| Kind          | Captures                                                                 | Fields                                                                  |
| :------------ | :----------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| **Component** | A unit with a clear job: a service, module or subsystem                  | `name`, `summary` with `Does / Owns / Does not / Touched when`          |
| **Decision**  | An architectural choice, like an ADR                                     | `title`, `context`, `decision`, `alternatives_rejected`, `consequences` |
| **Lesson**    | A rule learned from an incident, a review, a bug or a correction         | `rule`, `why`, `when`                                                   |

The agent reads cards with `arch_context` and writes them with `arch_record_component`,
`arch_record_decision` and `arch_record_lesson`. `arch_list` lists every card,
`arch_suggest_components` names the most-called files no component covers yet, and
`arch_delete` removes cards. Every card shows when it was last updated, so the agent can
tell old memory from new and check it against the code.

## No duplicates

A new card is compared with the existing ones (cosine similarity of
[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) vectors):

- `≥ 0.85` is a duplicate: a decision is refused, so the agent must reconcile it or
  supersede the old one; a lesson refreshes the existing card ("rule confirmed");
- `0.70 – 0.85` is similar: the agent is shown the match so it can refine the wording or
  supersede it;
- `< 0.70` is new.

A decision with `supersedes` skips the check and marks the old one `superseded`: it no
longer shows in search but stays in history.

`arch_context` takes `min_score` (default `0.45`). Lower it for a sparse memory, raise it
for only strong matches. When nothing clears the threshold, the tool says so, so the agent
rephrases instead of inventing context.

## Only on the coding endpoint

Every `arch_*` tool, read and write, is on `/mcp`, where the agent can check a card against
the code. The support endpoint has none: a rationale support cannot verify is not
something it should quote, so support sends "why is it built this way?" to an engineer.

Cards live in their own Qdrant collection per group, `paparats_<group>_arch`.

## Getting started

Three workflow prompts on the coding endpoint:

- **`init_arch_memory`**: walks the repository, finds 8–20 components along domain
  boundaries, records them, and records decisions that comments or the README make
  obvious. Run it once per group after installing.
- **`audit_architecture`**: goes through a group's memory, flags cards older than 90 days,
  checks their anchors against the code and lists what to update or supersede, for your
  approval.
- **`record_lesson_from_correction`**: turns a correction you gave the agent into a lesson
  card, without recording every typo.

## Is it used?

With `PAPARATS_METRICS=true` the server counts reads and writes and records the scores of
the cards it returns:

- `paparats_arch_context_calls_total{group}`: reads per group;
- `paparats_arch_write_total{kind, status}`: writes by kind and outcome;
- `paparats_arch_search_score`: scores of returned cards (after `min_score`);
- `paparats_arch_collection_size{group, kind, status}`: card counts, updated when
  `arch://stats/{group}` is read.

They show a memory nobody writes to, a duplicate check that refuses too much, or a group
where every question gets weak matches.

## Glossary

Each group also has a glossary (`paparats_<group>_terms`): abbreviations, product names
and domain terms, each with a definition and aliases. `term_search` and `term_list` read
it on the coding and support endpoints; `term_record` and `term_delete` are coding only.
Like decisions, a near-identical term is refused and the existing one returned.
