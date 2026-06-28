// QuickBooks Online adapter — token lifecycle + REST. Zero runtime deps (native fetch).
// Single source of truth for QBO I/O; consumed as a library or via the `qbo` CLI.
// Customer-agnostic: no LLM, no business logic, no secrets baked in.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Token file is configurable so the consumer (a job, a container) owns the secret location.
const TOKENS_FILE = process.env.QBO_TOKENS_FILE || join(ROOT, "qbo_tokens.json");
const MINOR_VERSION = "73"; // pin; verify latest at build (minor 1-74 deprecated)
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface Tokens {
  refresh_token: string;
  realm_id: string;
  environment: "sandbox" | "production";
}

export function loadTokens(): Tokens {
  if (!existsSync(TOKENS_FILE)) throw new Error(`No tokens file at ${TOKENS_FILE} — run \`qbo auth\` first.`);
  return JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
}
export function saveTokens(t: Tokens): void {
  writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
}

function clientCreds(): { id: string; secret: string } {
  const id = process.env.QBO_CLIENT_ID;
  const secret = process.env.QBO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set QBO_CLIENT_ID and QBO_CLIENT_SECRET.");
  return { id, secret };
}

/** Exchange the long-lived refresh token for a short-lived access token; rotate + persist. */
export async function refreshAccessToken(t: Tokens): Promise<string> {
  const { id, secret } = clientCreds();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token: string };
  if (j.refresh_token && j.refresh_token !== t.refresh_token) {
    t.refresh_token = j.refresh_token;
    saveTokens(t); // Intuit rotates the refresh token periodically
  }
  return j.access_token;
}

function baseUrl(env: string, realm: string): string {
  const host = env === "production" ? "quickbooks.api.intuit.com" : "sandbox-quickbooks.api.intuit.com";
  return `https://${host}/v3/company/${realm}`;
}
export function appUrl(env: string): string {
  return env === "production" ? "https://app.qbo.intuit.com" : "https://app.sandbox.qbo.intuit.com";
}

async function api(token: string, t: Tokens, path: string, init?: RequestInit & { query?: string }): Promise<any> {
  const url = new URL(`${baseUrl(t.environment, t.realm_id)}${path}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  if (init?.query) url.searchParams.set("query", init.query);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`QBO ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Run a QBO SQL-ish query and return the raw QueryResponse object. */
export async function query(token: string, t: Tokens, sql: string): Promise<any> {
  const data = await api(token, t, "/query", { query: sql });
  return data?.QueryResponse ?? {};
}

// --- Reads ---------------------------------------------------------------------

export interface TimeEntry {
  id: string;
  customerId?: string;
  customerName?: string;
  employeeName?: string;
  itemId?: string;
  hours: number;
  rate: number;
  txnDate?: string;
  description: string;
}

/** Read billable TimeActivity since a date. */
export async function listTimeActivities(token: string, t: Tokens, sinceISO: string): Promise<TimeEntry[]> {
  const sql =
    `SELECT * FROM TimeActivity WHERE BillableStatus = 'Billable' AND TxnDate >= '${sinceISO}' MAXRESULTS 500`;
  const qr = await query(token, t, sql);
  const rows = qr?.TimeActivity ?? [];
  return rows.map((ta: any) => ({
    id: ta.Id,
    customerId: ta.CustomerRef?.value,
    customerName: ta.CustomerRef?.name,
    employeeName: ta.EmployeeRef?.name ?? ta.VendorRef?.name,
    itemId: ta.ItemRef?.value,
    hours: (ta.Hours ?? 0) + (ta.Minutes ?? 0) / 60,
    rate: ta.HourlyRate ?? 0,
    txnDate: ta.TxnDate,
    description: ta.Description ?? "",
  }));
}

export interface ServiceItem { id: string; name: string; unitPrice?: number; }

/** The firm's QuickBooks Service Items — the canonical billing line items. */
export async function listServiceItems(token: string, t: Tokens): Promise<ServiceItem[]> {
  const qr = await query(token, t, "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 500");
  const rows = qr?.Item ?? [];
  return rows
    .filter((i: any) => i.Active !== false)
    .map((i: any) => ({ id: i.Id, name: i.Name, unitPrice: i.UnitPrice }));
}

/** First Income account id (Service Items require an IncomeAccountRef). */
export async function findIncomeAccountId(token: string, t: Tokens): Promise<string> {
  const qr = await query(token, t, "SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1");
  const acct = (qr?.Account ?? [])[0];
  if (!acct) throw new Error("No Income account found in this company.");
  return acct.Id;
}

// --- Creates (generic; used for seeding / agent actions) ------------------------

export async function createCustomer(
  token: string, t: Tokens, displayName: string, email?: string,
): Promise<{ id: string; displayName: string }> {
  const body: any = { DisplayName: displayName };
  if (email) body.PrimaryEmailAddr = { Address: email };
  const j = await api(token, t, "/customer", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { id: j.Customer.Id, displayName: j.Customer.DisplayName };
}

/** Set (sparse-update) a customer's primary email — fetches SyncToken, then patches. */
export async function setCustomerEmail(token: string, t: Tokens, customerId: string, email: string): Promise<void> {
  const qr = await query(token, t, `SELECT * FROM Customer WHERE Id = '${customerId}'`);
  const c = (qr?.Customer ?? [])[0];
  if (!c) throw new Error(`customer ${customerId} not found`);
  const body = { Id: customerId, SyncToken: c.SyncToken, sparse: true, PrimaryEmailAddr: { Address: email } };
  await api(token, t, "/customer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function createEmployee(
  token: string, t: Tokens, givenName: string, familyName: string,
): Promise<{ id: string; displayName: string }> {
  const body = { GivenName: givenName, FamilyName: familyName, DisplayName: `${givenName} ${familyName}` };
  const j = await api(token, t, "/employee", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { id: j.Employee.Id, displayName: j.Employee.DisplayName };
}

export async function createServiceItem(
  token: string, t: Tokens, name: string, unitPrice: number, incomeAccountId: string,
): Promise<{ id: string; name: string }> {
  const body = { Name: name, Type: "Service", IncomeAccountRef: { value: incomeAccountId }, UnitPrice: unitPrice };
  const j = await api(token, t, "/item", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { id: j.Item.Id, name: j.Item.Name };
}

export interface NewTimeActivity {
  employeeId: string;
  customerId: string;
  itemId: string;
  hours: number;     // whole hours
  minutes?: number;  // 0-59
  rate: number;
  txnDate: string;   // YYYY-MM-DD
  description: string;
}

export async function createTimeActivity(token: string, t: Tokens, ta: NewTimeActivity): Promise<{ id: string }> {
  const body = {
    NameOf: "Employee",
    EmployeeRef: { value: ta.employeeId },
    CustomerRef: { value: ta.customerId },
    ItemRef: { value: ta.itemId },
    BillableStatus: "Billable",
    Taxable: false,
    HourlyRate: ta.rate,
    Hours: ta.hours,
    Minutes: ta.minutes ?? 0,
    TxnDate: ta.txnDate,
    Description: ta.description,
  };
  const j = await api(token, t, "/timeactivity", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { id: j.TimeActivity.Id };
}

// --- Invoices ------------------------------------------------------------------

export interface DraftLine { description: string; hours: number; rate: number; itemId: string; }

/** Create an UNSENT invoice (= draft). Returns id + review URL. Amounts are computed by caller inputs. */
export async function createInvoiceDraft(
  token: string, t: Tokens, customerId: string, lines: DraftLine[],
): Promise<{ id: string; docNumber: string; total: number; url: string }> {
  const body = {
    CustomerRef: { value: customerId },
    Line: lines.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: Math.round(l.hours * l.rate * 100) / 100,
      Description: l.description,
      SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: Math.round(l.hours * 100) / 100, UnitPrice: l.rate },
    })),
  };
  const j = await api(token, t, "/invoice", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const inv = j.Invoice;
  return {
    id: inv.Id, docNumber: inv.DocNumber, total: inv.TotalAmt,
    url: `${appUrl(t.environment)}/app/invoice?txnId=${inv.Id}`,
  };
}

/** Delete an invoice (used by tests/teardown). */
export async function deleteInvoice(token: string, t: Tokens, invoiceId: string, syncToken = "0"): Promise<void> {
  await api(token, t, "/invoice?operation=delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Id: invoiceId, SyncToken: syncToken }),
  });
}

/** Delete a TimeActivity (used to clean sandbox/sample data). */
export async function deleteTimeActivity(token: string, t: Tokens, id: string, syncToken = "0"): Promise<void> {
  await api(token, t, "/timeactivity?operation=delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Id: id, SyncToken: syncToken }),
  });
}

/** Send (email) an invoice; QBO flips EmailStatus -> EmailSent (sent-tracking source of truth). */
export async function sendInvoice(token: string, t: Tokens, invoiceId: string, email?: string): Promise<string> {
  const path = `/invoice/${invoiceId}/send` + (email ? `?sendTo=${encodeURIComponent(email)}` : "");
  const j = await api(token, t, path, { method: "POST", headers: { "Content-Type": "application/octet-stream" } });
  return j.Invoice?.EmailStatus ?? "unknown";
}

/** Read one invoice (id, EmailStatus, SyncToken, total) — for verification/teardown. */
export async function getInvoice(token: string, t: Tokens, invoiceId: string): Promise<any> {
  const j = await api(token, t, `/invoice/${invoiceId}`);
  return j.Invoice;
}
