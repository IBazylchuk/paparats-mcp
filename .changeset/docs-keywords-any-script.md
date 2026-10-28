---
'@paparats/server': patch
'@paparats/indexer': patch
---

Docs search matches keywords in any script, not only plain Latin letters: Cyrillic, Greek and other words are kept whole, accents on Latin letters are dropped (`cafe` finds `café`, where `über` used to become `ber`), and Chinese and Japanese text is matched by two-character pieces. The keyword statistics are rebuilt once from the stored documents at startup; the documents' own keyword vectors catch up on the next docs pass. Plain ASCII text is tokenised as before.
