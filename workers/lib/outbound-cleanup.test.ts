// Table tests for the deterministic outbound artifact cleanup (#5).
// Run: node --import tsx --test workers/lib/outbound-cleanup.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	cleanOutboundBody,
	hasVisibleText,
	MAX_OUTBOUND_HTML_BYTES,
} from "./outbound-cleanup.ts";

// Each row: [label, input, expectedOutput, expectedRemovedKinds]
const REMOVAL_ROWS: Array<[string, string, string, string[]]> = [
	// 1. thinking
	["thinking block", "<p>Hi</p><thinking>secret\nmore</thinking><p>Bye</p>", "<p>Hi</p><p>Bye</p>", ["thinking"]],
	["think block", "<think>x</think>Hello", "Hello", ["thinking"]],
	["escaped thinking", "&lt;thinking&gt;plan&lt;/thinking&gt;Visible", "Visible", ["thinking"]],
	["escaped think", "&lt;think&gt;a&lt;/think&gt;V", "V", ["thinking"]],
	// 2. tool_call
	["tool_call block", '<tool_call>{"x":1}</tool_call>Done', "Done", ["tool_call"]],
	["function_call block", "A<function_call>f()</function_call>B", "AB", ["tool_call"]],
	["escaped tool_call", "A&lt;tool_call&gt;x&lt;/tool_call&gt;B", "AB", ["tool_call"]],
	// 3. special_token
	["im_start/eot tokens", "<|im_start|>Hello<|eot_id|>", "Hello", ["special_token"]],
	["end token", "Ok<|end|>", "Ok", ["special_token"]],
	["escaped token", "&lt;|eot_id|&gt;X", "X", ["special_token"]],
	["TOOL_CALLS marker", "Hi [TOOL_CALLS]there", "Hi there", ["special_token"]],
	// 4. ai_disclaimer
	[
		"plain-text disclaimer line",
		"Hello there.\nAs an AI language model, I cannot send this.\nBye",
		"Hello there.\nBye",
		["ai_disclaimer"],
	],
	[
		"p disclaimer element",
		"<p>Intro</p><p>As an AI assistant I wrote this.</p><p>End</p>",
		"<p>Intro</p><p>End</p>",
		["ai_disclaimer"],
	],
	["div disclaimer element", "<div>As an AI model here.</div>X", "X", ["ai_disclaimer"]],
	[
		"short p disclaimer, language model",
		"<p>As an AI language model, I cannot browse the web.</p>X",
		"X",
		["ai_disclaimer"],
	],
	[
		"short p disclaimer with inline em",
		"<p><em>As an AI assistant</em>, I don't have opinions.</p>X",
		"X",
		["ai_disclaimer"],
	],
	["short plain disclaimer line", "As an AI model, I can't do that.\nX", "X", ["ai_disclaimer"]],
	// 5. tool_json
	[
		"plain-text tool JSON line",
		'{"name": "send_email", "arguments": {"to": "a@b.c"}}\nHi',
		"Hi",
		["tool_json"],
	],
	[
		"p tool JSON element (entity-encoded quotes)",
		"<p>{&quot;tool&quot;: &quot;x&quot;, &quot;parameters&quot;: {}}</p>X",
		"X",
		["tool_json"],
	],
	[
		"fenced json tool call",
		'Intro\n```json\n{"name":"f","args":{}}\n```\nOutro',
		"Intro\nOutro",
		["tool_json"],
	],
];

// Look-alikes: must come back byte-identical.
const KEEP_ROWS: Array<[string, string]> = [
	["thinking verb in a p", "<p>We think this works</p>"],
	["tool_call as prose", "the tool_call column is empty"],
	["pipe-bracket in prose", "a <| b"],
	["AI company sentence", "As an AI company we ship fast."],
	["AI-first team sentence", "As an AI-first team, we ship."],
	["phrase mid-sentence", "<p>The phrase As an AI language model can appear mid-sentence.</p>"],
	["JSON config sample (no name/arguments keys)", '{"name": "app", "port": 8080}'],
	["invalid JSON with both keys", '{"name": "x", "arguments": {}'],
	["JSON array (not an object)", '[{"name":"a","arguments":{}}]'],
	["config JSON in pre", '<pre>{"name":"db","port":1}</pre>'],
	["unclosed thinking tag", "<thinking>never closed"],
	// s2: an ai_disclaimer must be short and carry no content-bearing markup.
	[
		"wrapper div with a small table (element carries real content)",
		"<div>As an AI assistant, here is your report:<br><table><tr><td>Revenue</td><td>120,000</td></tr></table></div>",
	],
	[
		"p with a br carrying data",
		"<p>As an AI assistant, I compiled this:<br>Revenue 120,000</p>",
	],
	[
		"div disclaimer with a link",
		'<div>As an AI model ... <a href="https://x.y">link</a></div>',
	],
	["250-char plain line starting with the phrase", "As an AI assistant, " + "x".repeat(230) + "\nNext"],
	["nested short disclaimer inside a list item", "<ul><li>As an AI model, no.</li></ul>"],
];

describe("cleanOutboundBody: artifact removal", () => {
	for (const [label, input, expected, removed] of REMOVAL_ROWS) {
		test(`removes ${label}`, () => {
			const out = cleanOutboundBody(input);
			assert.equal(out.body, expected);
			assert.deepEqual(out.removed, removed);
		});
	}
});

describe("cleanOutboundBody: look-alikes are kept", () => {
	for (const [label, input] of KEEP_ROWS) {
		test(`keeps ${label}`, () => {
			const out = cleanOutboundBody(input);
			assert.equal(out.body, input);
			assert.deepEqual(out.removed, []);
		});
	}
});

describe("cleanOutboundBody: no-op and byte preservation", () => {
	test("input without artifacts is returned identically", () => {
		const input = "<p>Hi</p>\n<p>Yo &amp; more &lt;b&gt;</p>";
		assert.ok(cleanOutboundBody(input).body === input);
	});

	test("CRLF, tabs and nbsp are preserved byte-for-byte", () => {
		const input = "  <p>Line&nbsp;one</p>\r\n\t<p>x\u00a0y</p>\r\n\n  ";
		const out = cleanOutboundBody(input);
		assert.ok(out.body === input);
		assert.deepEqual(out.removed, []);
	});

	test("no trim: leading and trailing whitespace is kept", () => {
		const out = cleanOutboundBody("\n <p>A</p> <thinking>x</thinking> \n");
		assert.equal(out.body, "\n <p>A</p>  \n");
	});
});

describe("hasVisibleText", () => {
	test("empty or whitespace/nbsp-only markup has no visible text", () => {
		assert.equal(hasVisibleText("<p><br></p>"), false);
		assert.equal(hasVisibleText("<p>&nbsp; </p>"), false);
		assert.equal(hasVisibleText(""), false);
	});

	test("markup with text has visible text", () => {
		assert.equal(hasVisibleText("<p>a</p>"), true);
	});

	test("an image-only body is visible content", () => {
		assert.equal(hasVisibleText('<p><img src="cid:x"></p>'), true);
	});

	test("nbsp-only paragraph is still not visible", () => {
		assert.equal(hasVisibleText("<p>&nbsp;</p>"), false);
	});

	test("cleanup of a body containing only an artifact leaves no visible text", () => {
		const out = cleanOutboundBody("<p><thinking>x</thinking></p>");
		assert.equal(hasVisibleText(out.body), false);
	});
});

describe("size cap constant", () => {
	test("MAX_OUTBOUND_HTML_BYTES is 3.5 MB", () => {
		assert.equal(MAX_OUTBOUND_HTML_BYTES, 3_500_000);
	});
});
