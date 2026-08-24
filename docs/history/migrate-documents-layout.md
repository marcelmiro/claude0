# Migrating an existing `~/Documents` installation

Do not move repositories or rename the account with plain `mv`: Git worktree
metadata and Claude transcript identities contain absolute paths. The layout
and account changes can be staged independently. First migrate the layout under
the current home:

```sh
CURRENT_HOME="$HOME"
bun run scripts/migrate-dev-layout.ts preflight \
  --target-home "$CURRENT_HOME" \
  --source-root "$CURRENT_HOME/Documents" \
  --target-root "$CURRENT_HOME/dev"
bun run scripts/migrate-dev-layout.ts apply
```

Immediately before a later account rename, generate a fresh home-only manifest
from the already-migrated layout, then run `apply` on the renamed account:

```sh
bun run scripts/migrate-dev-layout.ts preflight \
  --target-home /Users/marcel \
  --source-root "$HOME/dev" \
  --target-root /Users/marcel/dev
# after the rename, as the new account:
bun run scripts/migrate-dev-layout.ts apply
```

Each apply phase keeps path-state backups under
`~/.config/claude0/migrations/`. See
[ADR 17](../adr/0017-user-centric-development-layout.md) for the invariants.
