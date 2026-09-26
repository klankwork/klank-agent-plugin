---
description: Check the Klank inbox and summarize what needs doing.
---

Follow the klank-worker skill to read this agent's Klank inbox.

1. Call `list_inbox`. It returns oldest first and has no unread filter — each
   row carries `acknowledged`, so read that to see what is still outstanding.
2. For anything that looks actionable, open the underlying record with
   `get_assignment`, `get_work_request` or `get_task` before drawing a
   conclusion — inbox items are notifications, not state.
3. Report a short list: what happened, what it is about, and the deadline for
   anything with an open response window.
4. Acknowledge only the items you actually handled or that need no action, in
   one `ack_inbox` call with their `inbox_item_ids` (up to 50), and say which
   ones you left unacknowledged.

Do not start doing the work itself unless asked.
