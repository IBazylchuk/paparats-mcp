---
'@paparats/server': minor
---

Links between repositories through GraphQL. A project pass reads the operations a project sends, its schemas and, for graphql-ruby, the code answering each field; each operation is read against its schema, so a link comes from the types, not from a matching name. `change_impact` and `find_usages` list the operations in other repositories reaching a chunk and the files using them, also from code several calls before a resolver, and tests sending them; `find_usages` names the server code answering what a chunk sends; `module_map` lists which repository calls whose API. Search and the index are unchanged. REST, queues and shared configuration are not linked yet, and other GraphQL servers link to the schema's line.
