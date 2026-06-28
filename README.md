# quickbooks-cli

A small, **zero-dependency** [QuickBooks Online](https://developer.intuit.com) command line **and**
library. Read billable time, manage customers / employees / service items, and create & send
invoices — from a shell, a script, or an agent. Native `fetch` only; no SDK, nothing to audit.

> Building automation on top of QuickBooks (a scheduled job, an AI agent, a back-office script)?
> `quickbooks-cli` is the thin, safe I/O layer. It does **QuickBooks**, nothing else — no business
> logic, no AI, no opinions. You bring those.

## Install

```bash
npm install quickbooks-cli      # as a library dependency
# or run the CLI directly:
npx quickbooks-cli --help
```

## CLI

```
qbo auth                       # one-time OAuth bootstrap -> tokens file
qbo list-time [days]           # billable TimeActivity (default 90d) as JSON
qbo list-items                 # the company's Service Items (billing line items)
qbo list-customers             # customers (id, name, email)
qbo draft [days]               # one DRAFT invoice per customer from billable time (raw, 1:1)
qbo send <invoiceId> [email]   # email an invoice; QBO sets EmailStatus=EmailSent
qbo status                     # local invoice lifecycle counts
```

### Setup

Create a free app at <https://developer.intuit.com> → copy the **Client ID / Secret**, add the
redirect URI `http://localhost:8000/callback`, then:

```bash
cp .env.example .env     # fill in QBO_CLIENT_ID / QBO_CLIENT_SECRET
qbo auth                 # browser consent -> writes qbo_tokens.json (gitignored)
qbo list-time 90
```

## Library

```ts
import {
  loadTokens, refreshAccessToken,
  listTimeActivities, listServiceItems,
  createCustomer, createEmployee, createServiceItem, createTimeActivity,
  createInvoiceDraft, sendInvoice, getInvoice, deleteInvoice, query,
} from "quickbooks-cli";

const t = loadTokens();
const token = await refreshAccessToken(t);
const items = await listServiceItems(token, t);
const draft = await createInvoiceDraft(token, t, customerId, [
  { itemId: items[0].id, description: "Q2 tax preparation", hours: 6, rate: 250 },
]);
console.log(draft.url); // unsent draft, ready for human review
```

Every function takes `(token, tokens, …)` so you control auth and can run many companies from one
process. The OAuth tokens file location is configurable via `QBO_TOKENS_FILE`.

## Security

`qbo_tokens.json`, `*tokens*.json`, `invoices.json`, and `.env` are gitignored. Your Client Secret
and OAuth tokens are never committed; in a container/k8s they become mounted Secrets.

## License

MIT
