---
'@paparats/server': minor
---

`search_code` puts the definition first when the query names a class or function. A query like `where is InvoiceTotal computed`, `charge_card retry` or `Billing::Invoice` now also fetches the chunks that define those names, so a definition that dense search left out of its candidates still gets ranked, and moves chunks that define a named identifier (×1.1) and files named after one (×1.05, `invoice_total.rb` for `InvoiceTotal`) up. Queries without code-shaped names are ranked as before. As with the test-file demotion, only the order changes: the similarity percentage and the confidence guidance stay the cosine similarity.

Together with ordering by how often a file changes (a separate entry in this release), on real agent queries over a Ruby codebase that no setting was chosen on, the right file came first for 82% of queries instead of 64%; on two other sets of real queries over that codebase, 66% instead of 54% and 58% instead of 48%. On this repository's own bench nothing changed (82% before and after).
