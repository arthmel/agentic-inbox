// sendEmail hands attachment BYTES to the EMAIL binding (#10 s1).
// Run: node --import tsx --test workers/email-sender.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "./email-sender.ts";

function fakeBinding() {
	const calls: Array<Record<string, any>> = [];
	const binding = {
		send: async (msg: Record<string, any>) => {
			calls.push(msg);
			return { messageId: "m-1" };
		},
	} as unknown as SendEmail;
	return { binding, calls };
}

const base = { to: "bob@example.org", from: "a@example.org", subject: "S", text: "hi" };

describe("sendEmail attachments", () => {
	test("binary payload with every byte value 0-255 arrives byte-identical", async () => {
		const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		const { binding, calls } = fakeBinding();
		await sendEmail(binding, {
			...base,
			attachments: [
				{ content: all.toString("base64"), filename: "all.bin", type: "application/octet-stream", disposition: "attachment" },
			],
		});
		assert.equal(calls.length, 1);
		const content = calls[0].attachments[0].content;
		assert.ok(content instanceof Uint8Array, "binding must receive bytes, not a base64 string");
		assert.ok(Buffer.from(content).equals(all));
	});

	test("inline attachment keeps contentId and disposition", async () => {
		const { binding, calls } = fakeBinding();
		await sendEmail(binding, {
			...base,
			attachments: [
				{
					content: Buffer.from("PNGDATA").toString("base64"),
					filename: "logo.png",
					type: "image/png",
					disposition: "inline",
					contentId: "logo-cid",
				},
			],
		});
		const att = calls[0].attachments[0];
		assert.equal(att.disposition, "inline");
		assert.equal(att.contentId, "logo-cid");
		assert.equal(att.filename, "logo.png");
		assert.equal(att.type, "image/png");
		assert.ok(Buffer.from(att.content).equals(Buffer.from("PNGDATA")));
	});

	test("invalid base64 throws before binding.send is called", async () => {
		const { binding, calls } = fakeBinding();
		await assert.rejects(
			sendEmail(binding, {
				...base,
				attachments: [{ content: "QU!D", filename: "bad.pdf", type: "application/pdf", disposition: "attachment" }],
			}),
			/bad\.pdf.*not valid base64/,
		);
		assert.equal(calls.length, 0);
	});

	test("send without attachments has no attachments key", async () => {
		const { binding, calls } = fakeBinding();
		await sendEmail(binding, base);
		assert.equal(calls.length, 1);
		assert.equal("attachments" in calls[0], false);
	});
});
