// Send-path tests for the deterministic outbound cleanup (#5).
// Drives the real toolSendEmail / toolSendReply / toolDraftEmail / toolUpdateDraft
// with a fake env. env.AI.run THROWS (except in the agent-path guard) and counts calls.
// Run: node --import tsx --test workers/lib/tools-send.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	toolSendEmail,
	toolSendReply,
	toolDraftEmail,
	toolUpdateDraft,
} from "./tools.ts";
import { buildQuotedReplyBlock } from "./email-helpers.ts";
import { Folders } from "../../shared/folders.ts";
import { MAX_OUTBOUND_HTML_BYTES } from "./outbound-cleanup.ts";

const MAILBOX = "agent@example.com";
const ORIGINAL_ID = "orig-1";

type State = {
	rateCalls: number;
	rateLimitError: string | null;
	sends: Array<Record<string, unknown>>;
	created: Array<{ folder: string; email: Record<string, unknown> }>;
	deleted: string[];
	aiCalls: number;
	aiMode: "throw" | "empty";
	emails: Map<string, Record<string, unknown>>;
};

function makeEnv(overrides: { originalBody?: string } = {}) {
	const state: State = {
		rateCalls: 0,
		rateLimitError: null,
		sends: [],
		created: [],
		deleted: [],
		aiCalls: 0,
		aiMode: "throw",
		emails: new Map(),
	};
	state.emails.set(ORIGINAL_ID, {
		id: ORIGINAL_ID,
		message_id: "<orig@example.org>",
		thread_id: "thread-1",
		sender: "client@example.org",
		recipient: MAILBOX,
		date: "2026-10-01T10:00:00.000Z",
		subject: "Question",
		body: overrides.originalBody ?? "<p>Original question?</p>",
		email_references: null,
		in_reply_to: null,
	});
	const stub = {
		checkSendRateLimit: async () => {
			state.rateCalls++;
			return state.rateLimitError;
		},
		getEmail: async (id: string) => state.emails.get(id) ?? null,
		createEmail: async (folder: string, email: Record<string, unknown>) => {
			state.created.push({ folder, email });
		},
		deleteEmail: async (id: string) => {
			state.deleted.push(id);
			return { ok: true };
		},
	};
	const env = {
		MAILBOX: { idFromName: (n: string) => n, get: () => stub },
		EMAIL: {
			send: async (msg: Record<string, unknown>) => {
				state.sends.push(msg);
				return { messageId: "sent-1" };
			},
		},
		AI: {
			run: async () => {
				state.aiCalls++;
				if (state.aiMode === "throw") {
					throw new Error("AI must not be called on the MCP send/draft path");
				}
				return { response: "" };
			},
		},
	};
	return { env: env as any, state };
}

type Res = Record<string, any>;
const bytes = (s: string) => new TextEncoder().encode(s).length;

// ~60 KB realistic report: headings, big table, query-string links, numbers,
// Hebrew text, &amp; entities, inline styles. Newline-joined so we can cut on "\n".
function bigHtml(): string {
	const parts: string[] = [
		'<div style="font-family: Arial, sans-serif; font-size: 14px">',
		'<h1 style="color:#123456">Quarterly report שלום</h1>',
		"<table border=1 cellpadding=4>",
	];
	let i = 0;
	let len = 0;
	while (len < 60_000) {
		i++;
		const row =
			`<tr><td>Row ${i}</td>` +
			`<td><a href="https://example.com/r?id=${i}&amp;ref=mail&amp;t=${i * 3}">link ${i}</a></td>` +
			`<td style="color:#${((i * 7919) % 0xffffff).toString(16).padStart(6, "0")}">${(i * 37.5).toFixed(2)}</td>` +
			`<td>שורה ${i} &amp; עוד טקסט</td></tr>`;
		parts.push(row);
		len += row.length + 1;
	}
	parts.push("</table>", "</div>");
	return parts.join("\n");
}

// Build { withArtifacts, expected } by splitting the base at two newlines and
// inserting artifacts there. expected is pure concatenation (no cleanup function).
function artifactFixture() {
	const base = bigHtml();
	const cut1 = base.indexOf("\n", 20_000);
	const cut2 = base.indexOf("\n", 40_000);
	const a = base.slice(0, cut1);
	const b = base.slice(cut1, cut2);
	const c = base.slice(cut2);
	const thinking = "<thinking>plan the send\nline two of the plan</thinking>";
	const token = "<|eot_id|>";
	return {
		withArtifacts: a + thinking + b + token + c,
		expected: a + b + c,
		base,
	};
}

const sentOf = (state: State) => state.sends[0]?.html as string;
const storedSent = (state: State) =>
	state.created.find((c) => c.folder === Folders.SENT)?.email.body as string;

describe("send_email: 60 KB body", () => {
	test("sent html is original minus exactly the artifact spans (AC1), stored == sent, no AI (AC2)", async () => {
		const { withArtifacts, expected } = artifactFixture();
		assert.ok(bytes(withArtifacts) > 59_000 && bytes(withArtifacts) < 200_000);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "client@example.org",
			subject: "Report",
			bodyHtml: withArtifacts,
		});
		assert.equal(res.status, "sent");
		assert.equal(res.message, "Email sent to client@example.org");
		assert.equal(state.sends.length, 1);
		assert.ok(sentOf(state) === expected);
		assert.ok(storedSent(state) === sentOf(state));
		assert.equal(state.aiCalls, 0);
	});

	test("same body without artifacts is sent byte-identical (AC1)", async () => {
		const { base } = artifactFixture();
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "client@example.org",
			subject: "Report",
			bodyHtml: base,
		});
		assert.equal(res.status, "sent");
		assert.ok(sentOf(state) === base);
		assert.ok(storedSent(state) === base);
		assert.equal(state.aiCalls, 0);
	});
});

describe("send_reply: 60 KB body", () => {
	test("sent html is cleaned body + unchanged quoted block; stored == sent; no AI (AC1, AC2)", async () => {
		const { withArtifacts, expected } = artifactFixture();
		const { env, state } = makeEnv();
		const res: Res = await toolSendReply(env, MAILBOX, {
			originalEmailId: ORIGINAL_ID,
			to: "client@example.org",
			subject: "Re: Question",
			bodyHtml: withArtifacts,
		});
		assert.equal(res.status, "sent");
		const quote = buildQuotedReplyBlock({
			date: "2026-10-01T10:00:00.000Z",
			sender: "client@example.org",
			body: "<p>Original question?</p>",
		});
		assert.ok(sentOf(state) === expected + quote);
		assert.ok(storedSent(state) === sentOf(state));
		assert.equal(state.aiCalls, 0);
	});
});

describe("AC2: no AI on the MCP send path across all sends", () => {
	test("aiCalls stays 0 over several sends", async () => {
		const { withArtifacts } = artifactFixture();
		const { env, state } = makeEnv();
		const r1: Res = await toolSendEmail(env, MAILBOX, { to: "a@x.org", subject: "s", bodyHtml: withArtifacts });
		const r2: Res = await toolSendReply(env, MAILBOX, {
			originalEmailId: ORIGINAL_ID,
			to: "a@x.org",
			subject: "Re: s",
			bodyHtml: "<p>Thanks, see attached figures &amp; links.</p>",
		});
		assert.equal(r1.status, "sent");
		assert.equal(r2.status, "sent");
		assert.equal(state.sends.length, 2);
		assert.equal(state.aiCalls, 0);
	});
});

describe("AC5: size cap", () => {
	const pad = (n: number) => "<p>" + "x".repeat(n - "<p></p>".length) + "</p>";

	test("exactly the cap is accepted", async () => {
		const body = pad(MAX_OUTBOUND_HTML_BYTES);
		assert.equal(bytes(body), 3_500_000);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, { to: "a@x.org", subject: "s", bodyHtml: body });
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
		assert.equal(state.rateCalls, 1);
	});

	test("one byte over is refused: cap error, no send, rate limit not called", async () => {
		const body = pad(MAX_OUTBOUND_HTML_BYTES + 1);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, { to: "a@x.org", subject: "s", bodyHtml: body });
		assert.ok("error" in res);
		assert.match(res.error, /Email body is 3\.50 MB; the limit is 3\.5 MB/);
		assert.equal(state.sends.length, 0);
		assert.equal(state.created.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.aiCalls, 0);
	});

	test("send_reply: the quoted block counts toward the cap", async () => {
		const original = "y".repeat(3_499_900);
		const quote = buildQuotedReplyBlock({
			date: "2026-10-01T10:00:00.000Z",
			sender: "client@example.org",
			body: original,
		});
		// Precondition: the reply alone is tiny; only the quoted block overflows the cap.
		assert.ok(bytes("<p>Thanks</p>" + quote) > MAX_OUTBOUND_HTML_BYTES);
		const { env, state } = makeEnv({ originalBody: original });
		const res: Res = await toolSendReply(env, MAILBOX, {
			originalEmailId: ORIGINAL_ID,
			to: "a@x.org",
			subject: "Re: s",
			bodyHtml: "<p>Thanks</p>",
		});
		assert.ok("error" in res);
		assert.match(res.error, /limit is 3\.5 MB/);
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
	});
});

describe("empty after cleanup", () => {
	test("send_email with only artifacts is refused before rate limit and send", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: "<p><thinking>x</thinking></p>",
		});
		assert.ok("error" in res);
		assert.match(res.error, /empty after removing agent artifacts/);
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.aiCalls, 0);
	});
});

describe("MCP drafts: deterministic cleanup, no AI", () => {
	test("toolDraftEmail with bodyCleanup deterministic keeps 60 KB body byte-identical, no AI", async () => {
		const { base } = artifactFixture();
		const { env, state } = makeEnv();
		const res: Res = await toolDraftEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "Draft",
			body: base,
			isPlainText: false,
			bodyCleanup: "deterministic",
		});
		assert.equal(res.status, "draft_saved");
		const stored = state.created[0]?.email.body as string;
		assert.ok(stored === base);
		assert.equal(state.aiCalls, 0);
	});

	test("toolUpdateDraft never calls AI and keeps a 60 KB body byte-identical", async () => {
		const { base } = artifactFixture();
		const { env, state } = makeEnv();
		state.emails.set("draft-1", {
			id: "draft-1",
			subject: "Old",
			recipient: "a@x.org",
			body: "<p>old</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: "t-d",
		});
		const res: Res = await toolUpdateDraft(env, MAILBOX, {
			draftId: "draft-1",
			bodyHtml: base,
		});
		assert.equal(res.status, "draft_updated");
		assert.deepEqual(state.deleted, ["draft-1"]);
		const stored = state.created[0]?.email.body as string;
		assert.ok(stored === base);
		assert.equal(state.aiCalls, 0);
	});
});

describe("agent path guard: EmailAgent still uses verifyDraft", () => {
	test("toolDraftEmail with runVerifyDraft (agent options) calls AI once", async () => {
		const { env, state } = makeEnv();
		state.aiMode = "empty";
		const res: Res = await toolDraftEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "Draft",
			body: "Hello there, this is a plain test body for the agent.",
			isPlainText: true,
			runVerifyDraft: true,
		});
		assert.equal(res.status, "draft_saved");
		assert.equal(state.aiCalls, 1);
	});
});

// s2: an ai_disclaimer wrapper div carrying a large table is real content, never removed.
describe("s2: ai_disclaimer wrapper around a large table is sent byte-identical", () => {
	test("send_email keeps <div>As an AI assistant…<table>…</table></div> whole, no AI", async () => {
		let rows = "";
		for (let i = 1; rows.length < 30_000; i++) {
			rows += `<tr><td>Row ${i}</td><td>${(i * 41.5).toFixed(2)}</td><td>שורה ${i} &amp; more</td></tr>`;
		}
		const input = `<div>As an AI assistant, here is your report:<table border=1>${rows}</table></div>`;
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "client@example.org",
			subject: "Report",
			bodyHtml: input,
		});
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
		assert.ok(sentOf(state) === input);
		assert.equal(state.aiCalls, 0);
	});
});

