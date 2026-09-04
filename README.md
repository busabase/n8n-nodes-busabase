# n8n-nodes-busabase

An [n8n](https://n8n.io) community node for [Busabase](https://busabase.com): list, get, create, and update records in a Base, and an instant trigger that starts a workflow when a record is created or updated — backed by Busabase's own webhook push, not polling.

```bash
npm install n8n-nodes-busabase
```

Then add it under **Settings → Community Nodes** in your n8n instance, or install locally for self-hosted n8n. Requires n8n's community-node API version 1 (`n8n-workflow` peer dependency).

## Credential

Add a **Busabase API** credential: a `Base URL` (defaults to `https://busabase.com`) and an `API Key`. Busabase's API key auth is a plain Bearer token (`apps/busabase-sdk`'s own auth shape), so this is a zero-custom-code integration — unlike Busabase's OAuth, which is standards-based PKCE but does not map onto n8n's generic OAuth2 credential type without dynamic client registration glue this package does not implement (no client secret, a shared client that only accepts loopback redirect URIs, a non-standard `resource` parameter). If that is ever wanted, it is a separate credential type, not a change to this one.

## Busabase node

**Operations**: List, Get, Create, Update. Every operation starts by picking a **Base** (populated live from your space); Create and Update then show a **Fields** mapper populated from that Base's actual field list — pick a Base, get exactly its columns, typed (number/checkbox/date fields map onto n8n's own field types; `select`/`multiselect` get a dropdown of the Base's real choices).

- **List** pages through `records.list` with a `Return All` toggle or a `Limit`, and a `Status` (`active`/`archived`).
- **Get** selects a record either by `Record ID` or by an exact `Field Value` match.
- **Create** / **Update** send the mapped fields through Busabase's `ChangeRequest` write path. `Auto-Merge` (default on) applies immediately if the credential has write access; when it does not, the change becomes a pending Change Request instead of a record — and **this node throws rather than reporting success**, since it does not yet exist.

## Busabase Trigger node

Registers a `webhook`-kind rule on activation (`create()`), removes it on deactivation (`delete()`), and re-registers if it is missing on a health check (`checkExists()`) — the standard n8n webhook-trigger lifecycle. **Event** is `New Record` or `Updated Record`; **Base** is optional (leave blank for every Base in the space).

Every delivery is verified before it reaches your workflow: Busabase HMAC-SHA256-signs the request body (`X-Busabase-Signature`) with a secret generated at registration time, and this node checks that signature against the raw request bytes — the same mechanism (and the same reason) n8n's own GitHub/Stripe/Shopify trigger nodes use, since re-serializing an already-parsed JSON body is not guaranteed to reproduce the exact bytes that were signed. A missing signature, a wrong one, or a request with no raw body to check all get rejected (HTTP 401) rather than let through — there is no fallback path that would let an unverified payload through as if it had been checked.

`Updated Record` requires Busabase's `record.updated` webhook event, added alongside this package.

## What this does not do (yet)

- **No join, no bulk operations, no delete.** Busabase deletes are review-first (a Change Request proposing archival, not an immediate deletion), which does not fit a single n8n "delete" action cleanly; left out rather than shipped with surprising semantics.
- **No OAuth credential.** See above.
- **Not published to npm yet** — `private: false` and the `n8n` manifest are in place, but this is the first cut.
