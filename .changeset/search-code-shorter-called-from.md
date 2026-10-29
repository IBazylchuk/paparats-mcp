---
'@paparats/server': patch
'@paparats/cli': patch
---

`search_code` answers shorter and says where code runs from: the first three results show their whole chunk, the rest their first 15 lines (`get_chunk` reads the whole one); the list of every name a chunk uses is gone, and each result lists the files it is called from (`Called from:`, through links the graph is sure of; paths and names in it, and after `Defines:`, are shown as plain text, so a file named like Markdown stays on its line). The coding instructions and `paparats instructions` ask to follow those callers when the question is where something is checked or triggered.
