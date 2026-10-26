---
'@paparats/server': patch
---

`change_impact` and `module_map` no longer trust names like `create` or `digest` in large codebases. A single lowercase word counted as common only when more than √(files) files used it, so in a 6,000-file Rails app `create` (33 files) and `digest` (18) stayed specific: every `Model.create` linked to a controller's `create` action, and `OpenSSL::HMAC.digest` to a model's `digest`. The bar is now a fixed 8 files. A real caller through such a name still shows when its file also uses something specific from the changed file, such as the class name. Ruby conversions (`to_s`, `to_h`) now count as common too: a model that defines `to_s` was listed as shared code "called from 1,337 files".

On a private Ruby codebase, `change_impact` of a webhook controller went from 40 dependents (all false, cut off at the limit) to 5, of a small queue class from 40 (cut off) to 34 with none through `create`, and of a model method lost 18 false callers through `digest`.
