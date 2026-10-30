---
'@paparats/server': patch
'@paparats/indexer': patch
---

`change_impact` no longer takes the code that sets a Ruby constant to a class (`SERVICE = ::Billing::Ledger`) for a holder of that class: such a link was followed whatever method of the class changed, so a file reading only `SERVICE::LIMIT` was listed as depending on every method. Passing the constant on (`dispatch(SERVICE)`) still holds the class, and calls through it link one by one as before. Symbols are extracted again (`SYMBOL_FORMAT` 10).
