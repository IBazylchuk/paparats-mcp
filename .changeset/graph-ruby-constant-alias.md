---
'@paparats/server': patch
---

A Ruby constant path through a class alias set in the same file (`Postings = ::Vendors::Acme::Postings`, then `Postings::Fetcher`) now links to that class's constant, instead of to every class of that name. On a private Ruby codebase this removed 1,014 edges and added 20; in a blind check against the code, all 20 new edges were real and none of 24 removed ones was.
