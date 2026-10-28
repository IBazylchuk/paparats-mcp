# Documentation search

Besides code, Paparats can index each repository's markdown and search it: `search_docs`
on every endpoint, `get_document` on the support and knowledge endpoints.

## Turning it on

It is off by default. With `paparats install`, add `INDEX_DOCS=true` to
`~/.paparats/.env` and run `paparats restart`; with the
[plain compose files](install.md#plain-docker-compose), the same line goes into the `.env`
next to them. Until then `search_docs`, `get_document` and the knowledge endpoint return
nothing.

Documents go into their own collection per group, `paparats_<group>_docs`, embedded with
Qwen3-Embedding-0.6B (or the cloud provider's text model). Unlike code search, docs search
is hybrid: vectors plus BM25 keywords, merged with reciprocal rank fusion. Keywords are
words of any script (accents on Latin letters dropped, so `cafe` finds `café`); Chinese
and Japanese text, written without spaces, is matched by two-character pieces. Results are
excerpts with their heading path and source link; `get_document` returns a whole page
section by section.

## Audience labels

Every document carries one **audience** label, and the endpoints can be limited to some
labels. That is how one index serves internal readers and a narrower audience (the
[knowledge endpoint](#knowledge-endpoint-knowledgemcp)) without the narrower one ever
seeing internal pages.

A document's label is decided at index time, first match wins:

1. its own frontmatter: `audience: client` in the leading `---` block;
2. the project default: `docs.audience` in `.paparats.yml`, or in `projects.yml` (per
   repo, or under `defaults.docs`; a repo's value beats `defaults`, and `projects.yml`
   beats the repo's own `.paparats.yml`);
3. otherwise `internal`.

```markdown
---
title: Leave policy
source_url: https://docs.example.com/leave-policy
audience: client
---

# Leave policy
```

```yaml
# projects.yml
repos:
  - url: org/handbook
    docs:
      audience: client # every page of the repo, unless its frontmatter says otherwise
```

Labels are lower-case letters, digits, `-` and `_`, at most 64 characters
(`^[a-z0-9][a-z0-9_-]{0,63}$`). An invalid label in a config file stops it from loading.
An invalid frontmatter value (wrong case, empty, a list) is logged with the file and the
value, and that document is stored as `internal`: never as the project default, which may
be wider than the author meant. Every indexing run rewrites every document, so a changed
label takes effect on the next run; nothing needs migrating.

`PAPARATS_DOCS_AUDIENCE=client,public` caps what the coding and support endpoints of one
server may return. The knowledge endpoint has a ceiling of its own.

## Knowledge endpoint (`/knowledge/mcp`)

A docs-only endpoint for a service in another network, typically an agent backend that
answers non-engineers and reaches Paparats through a load balancer. It is **off unless
configured**, and when on it enforces everything itself rather than trusting the caller or
the proxy:

- two tools, `search_docs` and `get_document`: no code, glossary, project list, health,
  analytics, resources or workflow prompts;
- `Authorization: Bearer <token>` on every request, compared in constant time and checked
  before the body is read (`401` with `WWW-Authenticate: Bearer` otherwise);
- only documents whose audience is in its ceiling and, when set, only its allowlisted
  projects. A caller's `audience` argument can only narrow that. A document outside the
  scope reads exactly like a missing one;
- stateless Streamable HTTP: every `POST` gets a fresh server and transport, no session id
  is issued, `GET` and `DELETE` answer `405`. No sticky sessions, no idle timeouts;
- a 64 kB body limit and a 1000-character query cap;
- its own instructions to the agent: cite the source link, fetch the whole document when an
  excerpt is not enough, report an empty result as "not documented", never treat the docs
  as a source of metrics or live data. `search_docs` also returns `structuredContent`
  (title, heading path, source URL, project, file, excerpt, included and total sections,
  last modified, score), so a wrapping service can build citations without parsing
  markdown.

| Variable                      | Meaning                                                                    |
| :---------------------------- | :------------------------------------------------------------------------- |
| `PAPARATS_KNOWLEDGE_TOKENS`   | Comma-separated bearer tokens, each at least 16 characters (`openssl rand -hex 32`). |
| `PAPARATS_KNOWLEDGE_AUDIENCE` | Required. Comma-separated labels the endpoint may serve. `internal` is refused, since every unlabelled document reads as `internal`. |
| `PAPARATS_KNOWLEDGE_PROJECTS` | Optional. Comma-separated projects the endpoint may serve.                |

With neither tokens nor audience set, the route does not exist (`404`). With only one, or a
value that is empty after trimming, the server refuses to start. `PAPARATS_DOCS_AUDIENCE`
and `PAPARATS_PROJECTS`, when set, narrow the endpoint further. The startup log prints the
endpoint, its effective ceiling and allowlist, never the tokens. Tool calls are recorded in
analytics with mode `knowledge`, attributed to the `X-Paparats-User` header when the caller
forwards one.

> **Set `PAPARATS_KNOWLEDGE_PROJECTS`.** Without it, a stray `audience: client` in some code
> repository's README is enough to publish that README through the endpoint. An allowlist
> of the curated documentation projects makes the label necessary but not sufficient.

Expose **only** this path, POST only. With nginx in front:

```nginx
server {
  listen 443 ssl;
  server_name knowledge.example.com;

  location = /knowledge/mcp {
    limit_except POST { deny all; }
    client_max_body_size 64k;
    proxy_pass http://paparats:9876;
    proxy_http_version 1.1;
    proxy_buffering off; # responses stream as text/event-stream
  }

  location / {
    return 404;
  }
}
```

Any load balancer works the same way: one rule for `POST /knowledge/mcp`, nothing else
forwarded, no session affinity. Check it from outside:

```bash
curl -sS -X POST https://knowledge.example.com/knowledge/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
