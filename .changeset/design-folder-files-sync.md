---
'tikk': minor
---

Files in a ticket's design folder sync to other machines as they are, and the cache never reads them
as tickets. When a sync clash gives a ticket a new ID, its design folder moves to the new ID too.
`tikk show --json` lists the files in a ticket's design folder.
