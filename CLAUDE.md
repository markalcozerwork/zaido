# Memory / path rules

- **Never read, edit, or otherwise act on anything under:**
  `C:\Users\Mark Alcozer\Desktop\Sync to my GDrive\Memory Folder\My Mind`
  This folder is off-limits — treat it as read-only/untouchable source material, not a target for changes.

- **All new files and paths created going forward are stored under:**
  `C:\Users\Mark Alcozer\Desktop\Sync to my GDrive\MJGA - extra`
  Use this as the base location for anything new, instead of the Memory Folder above.

These are local filesystem paths on the user's Windows machine. They apply when working
from a local Claude Code session with access to that machine's filesystem. A cloud session
(like one running against this repository in an isolated container) has no access to either
path and cannot read or write to them directly.
