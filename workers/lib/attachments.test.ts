// Filename sanitizing for outbound and stored attachments (#4 s1).
// Run: node --import tsx --test workers/lib/attachments.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAttachmentFilename, base64ToBytes } from "./attachments.ts";

describe("base64ToBytes", () => {
	const cases: Array<[string, string, number[]]> = [
		["valid, no padding", "QUJD", [0x41, 0x42, 0x43]],
		["valid, whitespace stripped", "QUJD\nREVG", [0x41, 0x42, 0x43, 0x44, 0x45, 0x46]],
		["padding 1 (=)", "QUI=", [0x41, 0x42]],
		["padding 2 (==)", "QQ==", [0x41]],
		["empty string", "", []],
	];
	for (const [name, input, expected] of cases) {
		test(`decodes: ${name}`, () => {
			assert.deepEqual(Array.from(base64ToBytes(input)), expected);
		});
	}

	test("invalid character throws", () => {
		assert.throws(() => base64ToBytes("QU!D"), /invalid base64/);
	});

	test("bad length (not a multiple of 4) throws", () => {
		assert.throws(() => base64ToBytes("QUJDR"), /invalid base64/);
	});

	test("decodes every byte value 0-255 exactly", () => {
		const all = Uint8Array.from({ length: 256 }, (_, i) => i);
		const b64 = Buffer.from(all).toString("base64");
		assert.deepEqual(base64ToBytes(b64), all);
	});
});

describe("sanitizeAttachmentFilename", () => {
	test("plain names are unchanged", () => {
		assert.equal(sanitizeAttachmentFilename("report.pdf"), "report.pdf");
		assert.equal(sanitizeAttachmentFilename("Q3 figures (final).xlsx"), "Q3 figures (final).xlsx");
	});

	test("path separators, reserved characters and control chars become _", () => {
		assert.equal(sanitizeAttachmentFilename("a/b\\c:d*e?f\"g<h>i|j\x01k.txt"), "a_b_c_d_e_f_g_h_i_j_k.txt");
	});

	test("CR/LF injection is neutralised", () => {
		assert.equal(sanitizeAttachmentFilename("../../etc/passwd\r\n.pdf"), ".._.._etc_passwd__.pdf");
	});

	test("empty, '.' and '..' become 'untitled'", () => {
		assert.equal(sanitizeAttachmentFilename(""), "untitled");
		assert.equal(sanitizeAttachmentFilename("."), "untitled");
		assert.equal(sanitizeAttachmentFilename(".."), "untitled");
	});

	test("names over 200 chars are truncated and keep the extension", () => {
		const out = sanitizeAttachmentFilename("a".repeat(250) + ".pdf");
		assert.equal(out.length, 200);
		assert.ok(out.endsWith(".pdf"));
	});

	test("long name without extension is truncated to 200 chars", () => {
		assert.equal(sanitizeAttachmentFilename("b".repeat(300)).length, 200);
	});
});
