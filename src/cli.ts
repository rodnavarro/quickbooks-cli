#!/usr/bin/env node
// quickbooks-cli — a small, zero-dependency QuickBooks Online command line + library.
// Commands: auth | list-time | list-items | list-customers | draft | send | status.
// Customer-agnostic: no LLM, no business logic. For classification/summarization, build a job
// on top of this package (see the library exports in src/index.ts).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadTokens, saveTokens, refreshAccessToken, listTimeActivities, listServiceItems,
  createInvoiceDraft, sendInvoice, query, type Tokens, type DraftLine,
} from "./qbo.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_FILE = process.env.QBO_STATE_FILE || join(ROOT, "invoices.json");
const REDIRECT = process.env.QBO_REDIRECT || "http://localhost:8000/callback";

function readState(): any[] { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : []; }
function writeState(s: any[]): void { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function out(o: unknown) { console.log(JSON.stringify(o, null, 2)); }
function daysAgoISO(n: number): string { const d = new Date(Date.now() - n * 864e5); return d.toISOString().slice(0, 10); }

function creds() {
  const id = process.env.QBO_CLIENT_ID, secret = process.env.QBO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set QBO_CLIENT_ID and QBO_CLIENT_SECRET.");
  return { id, secret };
}

// --- auth: one-time OAuth bootstrap -> tokens file ------------------------------
async function cmdAuth() {
  const { id, secret } = creds();
  const env = (process.env.QBO_ENVIRONMENT as Tokens["environment"]) || "sandbox";
  const authUrl =
    `https://appcenter.intuit.com/connect/oauth2?client_id=${id}` +
    `&response_type=code&scope=com.intuit.quickbooks.accounting` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=quickbooks-cli`;
  console.error("Open this URL to authorize:\n", authUrl, "\n");

  const code: { value?: string; realm?: string } = {};
  await new Promise<void>((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url || "", "http://localhost:8000");
      if (u.pathname !== "/callback") { res.end(); return; }
      code.value = u.searchParams.get("code") || undefined;
      code.realm = u.searchParams.get("realmId") || undefined;
      res.end("QuickBooks connected. You can close this tab.");
      server.close(); resolve();
    }).listen(8000, () => console.error("Waiting for redirect on", REDIRECT));
  });
  if (!code.value || !code.realm) throw new Error("No code/realmId captured.");

  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code.value, redirect_uri: REDIRECT }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { refresh_token: string };
  saveTokens({ refresh_token: j.refresh_token, realm_id: code.realm, environment: env });
  console.error(`Saved tokens. realm_id=${code.realm} env=${env}`);
}

async function withToken<T>(fn: (token: string, t: Tokens) => Promise<T>): Promise<T> {
  const t = loadTokens(); const token = await refreshAccessToken(t);
  return fn(token, t);
}

// --- list-time -----------------------------------------------------------------
async function cmdListTime(days: number) {
  out(await withToken((token, t) => listTimeActivities(token, t, daysAgoISO(days))));
}

// --- list-items: the firm's Service Items (billing line items) ------------------
async function cmdListItems() {
  out(await withToken((token, t) => listServiceItems(token, t)));
}

// --- list-customers ------------------------------------------------------------
async function cmdListCustomers() {
  out(await withToken(async (token, t) => {
    const qr = await query(token, t, "SELECT * FROM Customer MAXRESULTS 500");
    return (qr?.Customer ?? []).map((c: any) => ({ id: c.Id, displayName: c.DisplayName, email: c.PrimaryEmailAddr?.Address }));
  }));
}

// --- draft: one draft invoice per customer from billable time (raw, 1:1, no LLM) -
async function cmdDraft(days: number) {
  out(await withToken(async (token, t) => {
    const entries = await listTimeActivities(token, t, daysAgoISO(days));
    const byCustomer = new Map<string, { name?: string; lines: DraftLine[] }>();
    for (const e of entries) {
      if (!e.customerId || !e.itemId) continue;
      const g = byCustomer.get(e.customerId) || { name: e.customerName, lines: [] };
      g.lines.push({ description: e.description, hours: e.hours, rate: e.rate, itemId: e.itemId });
      byCustomer.set(e.customerId, g);
    }
    const state = readState(); const created = [];
    for (const [customerId, g] of byCustomer) {
      const inv = await createInvoiceDraft(token, t, customerId, g.lines);
      const rec = { ...inv, customerId, customer: g.name, status: "drafted", at: new Date().toISOString() };
      state.push(rec); created.push(rec);
    }
    writeState(state); return { created };
  }));
}

// --- send ----------------------------------------------------------------------
async function cmdSend(invoiceId: string, email?: string) {
  out(await withToken(async (token, t) => {
    const emailStatus = await sendInvoice(token, t, invoiceId, email);
    const state = readState();
    const rec = state.find((r: any) => r.id === invoiceId);
    if (rec) { rec.status = "sent"; rec.emailStatus = emailStatus; rec.sentAt = new Date().toISOString(); writeState(state); }
    return { invoiceId, emailStatus, status: "sent" };
  }));
}

// --- status --------------------------------------------------------------------
function cmdStatus() {
  const state = readState();
  const counts = state.reduce((a: any, r: any) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  out({ counts, invoices: state });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "auth": await cmdAuth(); break;
      case "list-time": await cmdListTime(Number(args[0] || 90)); break;
      case "list-items": await cmdListItems(); break;
      case "list-customers": await cmdListCustomers(); break;
      case "draft": await cmdDraft(Number(args[0] || 90)); break;
      case "send": await cmdSend(args[0], args[1]); break;
      case "status": cmdStatus(); break;
      default:
        console.error("usage: qbo <auth | list-time [days] | list-items | list-customers | draft [days] | send <invoiceId> [email] | status>");
        process.exit(1);
    }
  } catch (e) {
    console.error("ERROR:", (e as Error).message);
    process.exit(1);
  }
}
main();
