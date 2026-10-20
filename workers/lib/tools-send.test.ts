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
	created: Array<{ folder: string; email: Record<string, unknown>; attachments?: unknown[] }>;
	puts: Array<{ key: string; body: Uint8Array }>;
	bucketThrow: boolean;
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
		puts: [],
		bucketThrow: false,
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
		createEmail: async (folder: string, email: Record<string, unknown>, attachments: unknown[] = []) => {
			state.created.push({ folder, email, attachments });
		},
		deleteEmail: async (id: string) => {
			state.deleted.push(id);
			return { ok: true };
		},
	};
	const env = {
		MAILBOX: { idFromName: (n: string) => n, get: () => stub },
		BUCKET: {
			put: async (key: string, body: Uint8Array) => {
				if (state.bucketThrow) throw new Error("R2 unavailable");
				state.puts.push({ key, body });
			},
		},
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

// ── MCP send_email: cc/bcc, text, attachments and limits (#4 s1) ───────────

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const PDF_B64 = PDF.toString("base64");
const padHtml = (n: number) => "<p>" + "x".repeat(n - "<p></p>".length) + "</p>";
const recips = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}@x.org`);
const sentCopy = (state: State) => state.created.find((c) => c.folder === Folders.SENT) as NonNullable<State["created"][number]>;

describe("AC1: send_email with cc/bcc, text and one PDF attachment", () => {
	test("binding gets cc/bcc/text/attachment; R2 gets the bytes; Sent copy stores metadata", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "client@example.org",
			subject: "Report",
			bodyHtml: "<p>See the attached report.</p>",
			text: "See the attached report.",
			cc: ["a@x.org", "b@x.org"],
			bcc: ["c@x.org"],
			attachments: [{ filename: "report.pdf", contentType: "application/pdf", contentBase64: PDF_B64 }],
		});
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
		const sent = state.sends[0];
		assert.deepEqual(sent.cc, ["a@x.org", "b@x.org"]);
		assert.deepEqual(sent.bcc, ["c@x.org"]);
		assert.equal(sent.text, "See the attached report.");
		const sentAtt = (sent.attachments as Array<Record<string, unknown>>)[0];
		assert.ok(sentAtt.content instanceof Uint8Array, "binding must receive bytes, not a base64 string");
		assert.ok(Buffer.from(sentAtt.content as Uint8Array).equals(PDF));
		assert.deepEqual(
			{ ...sentAtt, content: undefined },
			{ content: undefined, filename: "report.pdf", type: "application/pdf", disposition: "attachment" },
		);
		assert.equal(state.puts.length, 1);
		assert.ok(state.puts[0].key.startsWith(`attachments/${res.messageId}/`));
		assert.ok(state.puts[0].key.endsWith("/report.pdf"));
		assert.ok(Buffer.from(state.puts[0].body).equals(PDF));
		const copy = sentCopy(state);
		assert.equal(copy.email.cc, "a@x.org, b@x.org");
		assert.equal(copy.email.bcc, "c@x.org");
		const atts = copy.attachments as Array<Record<string, unknown>>;
		assert.equal(atts.length, 1);
		assert.equal(atts[0].filename, "report.pdf");
		assert.equal(atts[0].mimetype, "application/pdf");
		assert.equal(atts[0].size, PDF.length);
	});
});

describe("AC2: total size cap includes attachments (checked before rate limit)", () => {
	test("6 MiB of attachments: size error, no send, no rate check, no R2 write, no Sent copy", async () => {
		const big = Buffer.alloc(6 * 1024 * 1024, 0x41).toString("base64");
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: "<p>big</p>",
			attachments: [{ filename: "big.bin", contentType: "application/octet-stream", contentBase64: big }],
		});
		assert.ok("error" in res);
		assert.match(res.error, /^Email is 6\.29 MB including attachments; the limit is 3\.5 MB/);
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.puts.length, 0);
		assert.equal(state.created.length, 0);
	});

	test("html + decoded attachment exactly 3_500_000 is accepted", async () => {
		const att = Buffer.alloc(1_000_000, 0x41);
		const html = padHtml(MAX_OUTBOUND_HTML_BYTES - att.length);
		assert.equal(bytes(html) + att.length, 3_500_000);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: html,
			attachments: [{ filename: "a.bin", contentType: "application/octet-stream", contentBase64: att.toString("base64") }],
		});
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
		assert.equal(state.rateCalls, 1);
	});

	test("html + text + decoded attachment exactly 3_500_000 is accepted (text counts)", async () => {
		const att = Buffer.alloc(1_000_000, 0x41);
		const text = "t".repeat(1000);
		const html = padHtml(MAX_OUTBOUND_HTML_BYTES - att.length - text.length);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: html,
			text,
			attachments: [{ filename: "a.bin", contentType: "application/octet-stream", contentBase64: att.toString("base64") }],
		});
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
	});

	test("one byte over 3_500_000 (html + decoded attachment) is refused", async () => {
		const att = Buffer.alloc(1_000_000, 0x41);
		const html = padHtml(MAX_OUTBOUND_HTML_BYTES - att.length + 1);
		assert.equal(bytes(html) + att.length, 3_500_001);
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: html,
			attachments: [{ filename: "a.bin", contentType: "application/octet-stream", contentBase64: att.toString("base64") }],
		});
		assert.ok("error" in res);
		assert.match(res.error, /limit is 3\.5 MB/);
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.puts.length, 0);
	});
});

describe("AC2b: recipient, base64, content-type and filename rules", () => {
	const base = { to: "a@x.org", subject: "s", bodyHtml: "<p>hi</p>" };

	test("50 recipients (to + cc + bcc) are accepted", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, { ...base, cc: recips("c", 25), bcc: recips("b", 24) });
		assert.equal(res.status, "sent");
		assert.equal(state.sends.length, 1);
	});

	test("51 recipients refused; bcc counts toward the limit", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, { ...base, cc: recips("c", 25), bcc: recips("b", 25) });
		assert.deepEqual(res, { error: "Too many recipients: 51 (max 50 across to, cc and bcc)." });
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
	});

	test("invalid base64 refused, nothing sent", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: "%%%%" }],
		});
		assert.deepEqual(res, { error: 'Attachment "a.pdf" is not valid base64.' });
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.puts.length, 0);
	});

	test("base64 with length not a multiple of 4 is refused", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: "QUJDR" }],
		});
		assert.deepEqual(res, { error: 'Attachment "a.pdf" is not valid base64.' });
		assert.equal(state.sends.length, 0);
	});

	test("whitespace inside base64 is stripped before sending", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: "QUJD\nREVG" }],
		});
		assert.equal(res.status, "sent");
		const content = (state.sends[0].attachments as Array<{ content: unknown }>)[0].content;
		assert.ok(content instanceof Uint8Array, "binding must receive bytes, not a base64 string");
		assert.ok(Buffer.from(content as Uint8Array).equals(Buffer.from("ABCDEF")));
	});

	test("invalid content type (CRLF header injection) refused, nothing sent", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "a.pdf", contentType: "text/html\r\nX: y", contentBase64: PDF_B64 }],
		});
		assert.deepEqual(res, { error: 'Attachment "a.pdf" has an invalid content type.' });
		assert.equal(state.sends.length, 0);
		assert.equal(state.rateCalls, 0);
		assert.equal(state.puts.length, 0);
	});

	test("path separators and CR/LF stripped from the filename in the send and the stored name", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "../../etc/passwd\r\n.pdf", contentType: "application/pdf", contentBase64: PDF_B64 }],
		});
		assert.equal(res.status, "sent");
		const expected = ".._.._etc_passwd__.pdf";
		const sentName = (state.sends[0].attachments as Array<{ filename: string }>)[0].filename;
		assert.equal(sentName, expected);
		assert.equal(sentCopy(state).attachments && (sentCopy(state).attachments as Array<{ filename: string }>)[0].filename, expected);
		assert.doesNotMatch(sentName, /[\/\\\r\n]/);
		const segments = state.puts[0].key.split("/");
		assert.equal(segments.length, 4);
		assert.equal(segments[3], expected);
	});

	test("filename '..' becomes 'untitled' in the send and the stored name", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			...base,
			attachments: [{ filename: "..", contentType: "application/pdf", contentBase64: PDF_B64 }],
		});
		assert.equal(res.status, "sent");
		assert.equal((state.sends[0].attachments as Array<{ filename: string }>)[0].filename, "untitled");
		assert.ok(state.puts[0].key.endsWith("/untitled"));
	});
});

describe("archive failure after a successful send", () => {
	test("R2 put throws: status sent with warning, Sent copy stored with no attachment rows", async () => {
		const { env, state } = makeEnv();
		state.bucketThrow = true;
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: "<p>hi</p>",
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: PDF_B64 }],
		});
		assert.equal(res.status, "sent");
		assert.equal(res.warning, "Sent, but the attachments could not be archived.");
		assert.ok(!("error" in res));
		assert.equal(state.sends.length, 1);
		assert.deepEqual(sentCopy(state).attachments, []);
	});
});

describe("AC5: send_email without the new fields is unchanged", () => {
	test("binding message has only to/from/subject/html; no R2 writes", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, { to: "a@x.org", subject: "s", bodyHtml: "<p>hi</p>" });
		assert.equal(res.status, "sent");
		assert.deepEqual(Object.keys(state.sends[0]).sort(), ["from", "html", "subject", "to"]);
		assert.equal(state.puts.length, 0);
	});

	test("text is cleaned with the same deterministic cleanup as html", async () => {
		const { env, state } = makeEnv();
		const res: Res = await toolSendEmail(env, MAILBOX, {
			to: "a@x.org",
			subject: "s",
			bodyHtml: "<p>hi</p>",
			text: "Hello <thinking>plan</thinking> world",
		});
		assert.equal(res.status, "sent");
		assert.ok(!String(state.sends[0].text).includes("<thinking>"));
		assert.equal(state.aiCalls, 0);
	});
});

