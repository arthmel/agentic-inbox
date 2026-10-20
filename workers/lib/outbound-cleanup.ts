// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Deterministic cleanup of agent artifacts in an outbound body (#5).
 *
 * Replaces the AI rewrite (verifyDraft) on the MCP send/draft path. Pure: no
 * Cloudflare or Durable Object imports. The output equals the input byte-for-byte
 * except for the removed spans: no trim, no whitespace normalization, no HTML
 * re-serialization, no entity changes.
 *
 * Conservative by design: when in doubt, the content is KEPT. A false removal
 * is far worse than a missed artifact.
 */

/** Cloudflare caps a message at 5 MiB incl. encoding; base64 is x4/3. */
export const MAX_OUTBOUND_HTML_BYTES = 3_500_000;

export type ArtifactKind =
	| "thinking"
	| "tool_call"
	| "special_token"
	| "ai_disclaimer"
	| "tool_json";

// 1. <thinking>…</thinking> and <think>…</think>, plain and HTML-escaped.
//    The body may not contain another opening tag of the same name, so an
//    unclosed opener never swallows text up to some later closer.
const THINKING_RE = /<(thinking|think)>(?:(?!<\1>)[\s\S])*?<\/\1>/gi;
const THINKING_ESC_RE = /&lt;(thinking|think)&gt;(?:(?!&lt;\1&gt;)[\s\S])*?&lt;\/\1&gt;/gi;

// 2. <tool_call>…</tool_call> and <function_call>…</function_call>.
const TOOL_CALL_RE = /<(tool_call|function_call)>(?:(?!<\1>)[\s\S])*?<\/\1>/gi;
const TOOL_CALL_ESC_RE =
	/&lt;(tool_call|function_call)&gt;(?:(?!&lt;\1&gt;)[\s\S])*?&lt;\/\1&gt;/gi;

// 3. Chat-template tokens: <|im_start|>, <|eot_id|>, <|end|> (and escaped), [TOOL_CALLS].
const SPECIAL_TOKEN_RE = /<\|[a-z0-9_]+\|>/gi;
const SPECIAL_TOKEN_ESC_RE = /&lt;\|[a-z0-9_]+\|&gt;/gi;
const TOOL_CALLS_MARKER_RE = /\[TOOL_CALLS\]/gi;

// 4 + 5. Whole <p> / <div> / <pre> elements (innermost first; no same-name nesting).
const ELEMENT_RE = /<(p|div|pre)\b[^>]*>((?:(?!<\1\b)[\s\S])*?)<\/\1\s*>/gi;

// 5. Fenced ```json … ``` blocks (one trailing newline consumed with the fence).
const JSON_FENCE_RE = /```[ \t]*json[ \t]*\r?\n([\s\S]*?)```(?:\r?\n)?/gi;

// 4. AI disclaimer: text must START with the phrase (word boundary keeps "AI-first", "AI company").
const DISCLAIMER_RE = /^As an AI (?:language model|assistant|model)\b/i;
// A disclaimer is only a disclaimer when it is short (s2, #5): longer text is content.
const DISCLAIMER_MAX_CHARS = 200;
// Markup that carries real content. An element holding any of these is never removed,
// whatever its text says (a wrapper <div> around a report table is not a disclaimer).
const NESTED_CONTENT_RE =
	/<\/?(table|tr|td|th|ul|ol|li|p|div|pre|blockquote|h[1-6]|img|a|br|hr)\b/i;

const TOOL_NAME_KEYS = ["name", "tool", "function"];
const TOOL_ARG_KEYS = ["arguments", "parameters", "args", "input"];

function decodeEntities(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function isToolJson(text: string): boolean {
	const t = text.trim();
	if (!t.startsWith("{") || !t.endsWith("}")) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(t);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const keys = Object.keys(parsed);
	return (
		keys.some((k) => TOOL_NAME_KEYS.includes(k)) &&
		keys.some((k) => TOOL_ARG_KEYS.includes(k))
	);
}

/** Classify the (already decoded, trimmed) text of a whole line/element. */
function classifyText(text: string): ArtifactKind | null {
	if (DISCLAIMER_RE.test(text) && text.length <= DISCLAIMER_MAX_CHARS) return "ai_disclaimer";
	if (isToolJson(text)) return "tool_json";
	return null;
}

function removeAll(
	s: string,
	re: RegExp,
	kind: ArtifactKind,
	note: (k: ArtifactKind) => void,
): string {
	return s.replace(re, () => {
		note(kind);
		return "";
	});
}

function removeElements(s: string, note: (k: ArtifactKind) => void): string {
	let cur = s;
	for (let pass = 0; pass < 50; pass++) {
		let changed = false;
		cur = cur.replace(ELEMENT_RE, (whole, _tag: string, inner: string) => {
			const text = decodeEntities(inner.replace(/<[^>]*>/g, " ")).trim();
			const kind = classifyText(text);
			if (!kind) return whole;
			// Element carries real content (table, list, image, link, block...): keep it.
			if (NESTED_CONTENT_RE.test(inner)) return whole;
			changed = true;
			note(kind);
			return "";
		});
		if (!changed) break;
	}
	return cur;
}

function removeJsonFences(s: string, note: (k: ArtifactKind) => void): string {
	return s.replace(JSON_FENCE_RE, (whole, content: string) => {
		if (!isToolJson(decodeEntities(content))) return whole;
		note("tool_json");
		return "";
	});
}

function removePlainLines(s: string, note: (k: ArtifactKind) => void): string {
	// Each piece keeps its trailing newline, so a removed line takes it along.
	let out = "";
	for (const piece of s.split(/(?<=\n)/)) {
		// Plain text only: a line with any tag bracket is not a whole plain line.
		if (piece === "" || /[<>]/.test(piece)) {
			out += piece;
			continue;
		}
		const kind = classifyText(decodeEntities(piece).trim());
		if (kind) {
			note(kind);
			continue;
		}
		out += piece;
	}
	return out;
}

/**
 * Remove agent artifacts from an outbound HTML/plain body.
 * `removed` lists the artifact kinds that were removed (deduplicated, pass order).
 */
export function cleanOutboundBody(body: string): { body: string; removed: string[] } {
	const removed: string[] = [];
	const note = (kind: ArtifactKind) => {
		if (!removed.includes(kind)) removed.push(kind);
	};

	let out = body;
	out = removeAll(out, THINKING_RE, "thinking", note);
	out = removeAll(out, THINKING_ESC_RE, "thinking", note);
	out = removeAll(out, TOOL_CALL_RE, "tool_call", note);
	out = removeAll(out, TOOL_CALL_ESC_RE, "tool_call", note);
	out = removeAll(out, SPECIAL_TOKEN_RE, "special_token", note);
	out = removeAll(out, SPECIAL_TOKEN_ESC_RE, "special_token", note);
	out = removeAll(out, TOOL_CALLS_MARKER_RE, "special_token", note);
	out = removeElements(out, note);
	out = removeJsonFences(out, note);
	out = removePlainLines(out, note);

	return { body: out, removed };
}

/**
 * True when the markup has visible text (anything but whitespace/nbsp after
 * stripping tags). Used to refuse sending an empty-after-cleanup body.
 */
export function hasVisibleText(html: string): boolean {
	// An image-only email is content, not an empty body.
	if (/<img\b/i.test(html)) return true;
	const text = decodeEntities(html.replace(/<[^>]*>/g, " "));
	return /\S/.test(text);
}
