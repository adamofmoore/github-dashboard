# github-dashboard

Local-only dashboard of my GitHub activity. Never pushed anywhere.

- `./start.sh` — starts the server (if not running) and opens http://localhost:4747
- Auth comes from `gh auth token`; nothing is stored beyond `cache/days.json` (past days' search results).
- Settings (repo filter, preset, custom range) live in the browser's localStorage.

Definitions
- Assigned issues: `assignee:me is:issue is:open`. In-flight = has an open linked PR.
- My open PRs: `author:me is:pr is:open`. In review = not draft.
- Issues opened: created by me that day. Issues closed: assigned to me, closed that day.
- PRs opened / merged: authored by me. PRs closed = closed without merge.
- Days are local midnight → midnight.
