// REST send / reply / forward: delivery is awaited before anything is stored,
// and a delivery failure returns the real error with no Sent copy (#4 AC3).
// Drives the real exported handlers with a fake Hono context.
// Run: node --import tsx --test workers/routes/send-routes.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleSendEmail } from "./send.ts";
import { handleReplyEmail, handleForwardEmail } from "./reply-forward.ts";

const MAILBOX = "agent@example.com";
const ORIGINAL_ID = "orig-1";
const PDF_B64 = Buffer.from("%PDF-1.4 fake").toString("base64");

type Log = string[];

function makeCtx(opts: {
	log: Log;
	body: Record<string, unknown>;
	sendError?: Error;
	bucketError?: Error;
	createError?: Error;
	rateLimitError?: string | null;
	params?: Record<string, string>;
}) {
	const { log } = opts;
	const created: Array<{ folder: string; atts: unknown[] }> = [];
	const original = {
		id: ORIGINAL_ID,
		folder_id: "inbox",
		subject: "Hello",
		sender: "alice@example.org",
		recipient: MAILBOX,
		date: "2026-10-01T10:00:00.000Z",
		body: "<p>orig</p>",
		message_id: "<orig@example.org>",
		in_reply_to: null,
		email_references: null,
		thread_id: "thread-1",
		attachments: [],
	};
	const stub = {
		getEmail: async (id: string) => (id === ORIGINAL_ID ? original : null),
		checkSendRateLimit: async () => {
			log.push("rateLimit");
			return opts.rateLimitError ?? null;
		},
		createEmail: async (folder: string, email: Record<string, unknown>, atts?: unknown[]) => {
			log.push("createEmail");
			created.push({ folder, atts: atts ?? [] });
			if (opts.createError) throw opts.createError;
			return { folder, email, atts };
		},
		markThreadRead: async () => {
			log.push("markThreadRead");
		},
	};
	let waitUntilCalls = 0;
	const sends: Array<Record<string, unknown>> = [];
	const ctx = {
		req: {
			param: (name: string) => (opts.params ?? { mailboxId: MAILBOX, id: ORIGINAL_ID })[name],
			json: async () => opts.body,
		},
		var: { mailboxStub: stub },
		env: {
			EMAIL: {
				send: async (msg: Record<string, unknown>) => {
					log.push("send");
					sends.push(msg);
					if (opts.sendError) throw opts.sendError;
					return { messageId: "provider-id" };
				},
			},
			BUCKET: {
				put: async (key: string) => {
					log.push("bucket.put");
					if (opts.bucketError) throw opts.bucketError;
					return { key };
				},
			},
		},
		executionCtx: {
			waitUntil: (_p: Promise<unknown>) => {
				waitUntilCalls++;
				log.push("waitUntil");
			},
		},
		json: (body: unknown, status = 200) => ({ body, status }),
	};
	return { ctx: ctx as any, sends, created, waitUntilCalls: () => waitUntilCalls };
}

const sendBody = {
	to: "bob@example.org",
	cc: "carol@example.org",
	from: MAILBOX,
	subject: "Hi",
	text: "hello",
	attachments: [
		{ content: PDF_B64, filename: "doc.pdf", type: "application/pdf", disposition: "attachment" },
	],
};

const routes: Array<{
	name: string;
	handler: (c: any) => Promise<any>;
	prefix: string;
	body: Record<string, unknown>;
	params?: Record<string, string>;
}> = [
	{ name: "send", handler: handleSendEmail, prefix: "Failed to send email:", body: sendBody, params: { mailboxId: MAILBOX } },
	{ name: "reply", handler: handleReplyEmail, prefix: "Failed to send reply:", body: sendBody },
	{ name: "forward", handler: handleForwardEmail, prefix: "Failed to forward email:", body: { ...sendBody, to: "dan@example.org" } },
];

for (const r of routes) {
	describe(`${r.name} route`, () => {
		test("AC3: delivery failure -> 502 with real error, nothing stored", async () => {
			const log: Log = [];
			const { ctx } = makeCtx({ log, body: r.body, params: r.params, sendError: new Error(`boom-${r.name}`) });
			const res = await r.handler(ctx);
			assert.equal(res.status, 502);
			assert.ok(res.body.error.includes(`boom-${r.name}`), res.body.error);
			assert.ok(res.body.error.startsWith(r.prefix), res.body.error);
			assert.equal(log.filter((e) => e === "createEmail").length, 0, "no Sent copy");
			assert.equal(log.filter((e) => e === "bucket.put").length, 0, "no R2 write");
			assert.equal(log.filter((e) => e === "waitUntil").length, 0, "no deferred send");
			assert.equal(log.filter((e) => e === "markThreadRead").length, 0, "thread not marked read");
		});

		test("success: 202 {id,status:sent}; send before bucket.put before createEmail; attachment+cc passed", async () => {
			const log: Log = [];
			const { ctx, sends, waitUntilCalls } = makeCtx({ log, body: r.body, params: r.params });
			const res = await r.handler(ctx);
			assert.equal(res.status, 202);
			assert.equal(res.body.status, "sent");
			assert.equal(typeof res.body.id, "string");
			const iSend = log.indexOf("send");
			const iPut = log.indexOf("bucket.put");
			const iCreate = log.indexOf("createEmail");
			assert.ok(iSend >= 0 && iPut >= 0 && iCreate >= 0, log.join(","));
			assert.ok(iSend < iPut && iPut < iCreate, `order: ${log.join(",")}`);
			assert.equal(sends.length, 1);
			assert.equal(sends[0].cc, "carol@example.org");
			const atts = sends[0].attachments as Array<Record<string, unknown>>;
			assert.equal(atts.length, 1);
			assert.equal(atts[0].content, PDF_B64);
			assert.equal(atts[0].filename, "doc.pdf");
			assert.equal(waitUntilCalls(), 0);
		});

		test("success body has no warning key", async () => {
			const log: Log = [];
			const { ctx } = makeCtx({ log, body: r.body, params: r.params });
			const res = await r.handler(ctx);
			assert.equal(res.status, 202);
			assert.deepEqual(Object.keys(res.body).sort(), ["id", "status"]);
		});

		test("AC3b: archive (R2) failure after a successful send -> 202 sent + warning, Sent row kept with []", async () => {
			const log: Log = [];
			const { ctx, sends, created } = makeCtx({ log, body: r.body, params: r.params, bucketError: new Error("r2-down") });
			const res = await r.handler(ctx);
			assert.equal(res.status, 202);
			assert.equal(res.body.status, "sent");
			assert.equal(typeof res.body.id, "string");
			assert.equal(res.body.warning, "Sent, but the copy could not be saved to Sent.");
			assert.equal(sends.length, 1, "send called once");
			assert.equal(created.length, 1, "createEmail called once");
			assert.deepEqual(created[0].atts, [], "Sent row written with no attachments");
		});

		test("AC3b: Sent-row write failure after a successful send -> 202 sent + warning", async () => {
			const log: Log = [];
			const { ctx, sends } = makeCtx({ log, body: r.body, params: r.params, createError: new Error("db-down") });
			const res = await r.handler(ctx);
			assert.equal(res.status, 202);
			assert.equal(res.body.status, "sent");
			assert.equal(res.body.warning, "Sent, but the copy could not be saved to Sent.");
			assert.equal(sends.length, 1, "send called once");
		});

		test("rate limited -> 429 and nothing sent", async () => {
			const log: Log = [];
			const { ctx, sends } = makeCtx({ log, body: r.body, params: r.params, rateLimitError: "Hourly limit reached" });
			const res = await r.handler(ctx);
			assert.equal(res.status, 429);
			assert.equal(sends.length, 0);
			assert.equal(log.filter((e) => e === "send").length, 0);
		});
	});
}
