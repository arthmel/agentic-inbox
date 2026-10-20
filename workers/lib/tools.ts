// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import {
	cleanOutboundBody,
	hasVisibleText,
	MAX_OUTBOUND_HTML_BYTES,
} from "./outbound-cleanup";
import { sendEmail } from "../email-sender";
import { storeAttachments, sanitizeAttachmentFilename, type StoredAttachment } from "./attachments";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── Outbound body hygiene (MCP path, #5) ───────────────────────────

/**
 * MCP paths use deterministic artifact cleanup (no AI). The built-in
 * EmailAgent keeps verifyDraft via `runVerifyDraft`.
 */
type BodyCleanup = "deterministic" | "ai";

const EMPTY_SEND_ERROR =
	"Email body is empty after removing agent artifacts — nothing sent.";
const EMPTY_DRAFT_ERROR =
	"Email body is empty after removing agent artifacts — draft not saved.";
const EMPTY_UPDATE_ERROR =
	"Email body is empty after removing agent artifacts — draft unchanged.";

/** Deterministic artifact cleanup. Errors when no visible text is left. */
function cleanOutboundOrError(
	body: string,
	emptyError: string,
): { body: string } | { error: string } {
	const { body: cleaned, removed } = cleanOutboundBody(body);
	if (removed.length > 0) {
		console.log("outbound-cleanup removed:", removed.join(","));
	}
	if (!hasVisibleText(cleaned)) return { error: emptyError };
	return { body: cleaned };
}

/** Hard size cap on the final html (UTF-8 bytes). Null when within the cap. */
function outboundSizeError(html: string): string | null {
	const bytes = new TextEncoder().encode(html).length;
	if (bytes <= MAX_OUTBOUND_HTML_BYTES) return null;
	return `Email body is ${(bytes / 1_000_000).toFixed(2)} MB; the limit is 3.5 MB (Cloudflare caps a whole message at 5 MiB). Shorten it or split it.`;
}

/** Max recipients across to, cc and bcc for MCP send_email. */
const MAX_RECIPIENTS = 50;
const ATTACHMENT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

type SendAttachmentInput = { filename: string; contentType: string; contentBase64: string };
type PreparedAttachment = { filename: string; contentType: string; content: string; size: number };

/**
 * Validate attachments (base64, content type) and compute decoded sizes.
 * Filenames are sanitized here, so the send and the R2 archive use the same name.
 */
function prepareAttachments(
	attachments: SendAttachmentInput[] | undefined,
): { error: string } | { items: PreparedAttachment[] } {
	const items: PreparedAttachment[] = [];
	for (const att of attachments ?? []) {
		const filename = sanitizeAttachmentFilename(att.filename);
		const content = att.contentBase64.replace(/\s+/g, "");
		const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
		const size = (content.length / 4) * 3 - padding;
		if (!ATTACHMENT_BASE64_RE.test(content) || content.length % 4 !== 0 || size <= 0) {
			return { error: `Attachment "${filename}" is not valid base64.` };
		}
		if (!CONTENT_TYPE_RE.test(att.contentType)) {
			return { error: `Attachment "${filename}" has an invalid content type.` };
		}
		items.push({ filename, contentType: att.contentType, content, size });
	}
	return { items };
}

/**
 * Total size cap: html + text + decoded attachments. Cloudflare caps the whole
 * ENCODED message at 5 MiB and base64 adds x4/3, so 3.5 MB decoded is the safe
 * budget. This is stricter than the issue's "5 MiB decoded", on purpose.
 */
function outboundTotalSizeError(totalBytes: number): string | null {
	if (totalBytes <= MAX_OUTBOUND_HTML_BYTES) return null;
	return `Email is ${(totalBytes / 1_000_000).toFixed(2)} MB including attachments; the limit is 3.5 MB (Cloudflare caps a whole message at 5 MiB incl. encoding). Send fewer or smaller files.`;
}

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** "deterministic" (MCP): artifact cleanup, no AI. Takes precedence over runVerifyDraft. */
		bodyCleanup?: BodyCleanup;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.bodyCleanup === "deterministic") {
		const cleaned = cleanOutboundOrError(processedBody, EMPTY_DRAFT_ERROR);
		if ("error" in cleaned) return cleaned;
		processedBody = cleaned.body;
	} else if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** "deterministic" (MCP): artifact cleanup, no AI. Takes precedence over runVerifyDraft. */
		bodyCleanup?: BodyCleanup;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.bodyCleanup === "deterministic") {
		const cleaned = cleanOutboundOrError(processedBody, EMPTY_DRAFT_ERROR);
		if ("error" in cleaned) return cleaned;
		processedBody = cleaned.body;
	} else if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Clean the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const cleaned = cleanOutboundOrError(rawBody, EMPTY_UPDATE_ERROR);
	if ("error" in cleaned) return cleaned;

	await stub.deleteEmail(params.draftId);
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: cleaned.body,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await stub.deleteEmail(draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.deleteEmail(emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	return { status: "deleted", emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Deterministic artifact cleanup of the caller's body only (no AI).
	// The quoted original is appended unchanged.
	const cleaned = cleanOutboundOrError(params.bodyHtml, EMPTY_SEND_ERROR);
	if ("error" in cleaned) return cleaned;
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = cleaned.body + quotedBlock;

	// Size cap and rate limit come after validation: a rejected body must not burn quota.
	const sizeError = outboundSizeError(fullBodyHtml);
	if (sizeError) return { error: sizeError };
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		text?: string;
		cc?: string[];
		bcc?: string[];
		attachments?: SendAttachmentInput[];
	},
): Promise<
	| { status: "sent"; messageId: string; message: string; warning?: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const cleaned = cleanOutboundOrError(params.bodyHtml, EMPTY_SEND_ERROR);
	if ("error" in cleaned) return cleaned;
	const sanitizedBody = cleaned.body;

	// Size cap and rate limit come after validation: a rejected body must not burn quota.
	const sizeError = outboundSizeError(sanitizedBody);
	if (sizeError) return { error: sizeError };

	const text = params.text !== undefined ? cleanOutboundBody(params.text).body : undefined;
	const cc = params.cc ?? [];
	const bcc = params.bcc ?? [];
	const recipientCount = 1 + cc.length + bcc.length;
	if (recipientCount > MAX_RECIPIENTS) {
		return { error: `Too many recipients: ${recipientCount} (max ${MAX_RECIPIENTS} across to, cc and bcc).` };
	}

	const prepared = prepareAttachments(params.attachments);
	if ("error" in prepared) return prepared;
	const attachmentBytes = prepared.items.reduce((sum, a) => sum + a.size, 0);
	const textBytes = new TextEncoder().encode(text ?? "").length;
	const totalError = outboundTotalSizeError(
		new TextEncoder().encode(sanitizedBody).length + textBytes + attachmentBytes,
	);
	if (totalError) return { error: totalError };

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const outboundAttachments = prepared.items.map((a) => ({
		content: a.content,
		filename: a.filename,
		type: a.contentType,
		disposition: "attachment" as const,
	}));

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
			...(text ? { text } : {}),
			...(cc.length ? { cc } : {}),
			...(bcc.length ? { bcc } : {}),
			...(outboundAttachments.length ? { attachments: outboundAttachments } : {}),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	// The message is out. Archive failures must not turn into an error: the caller would retry and double-send.
	let attachmentData: StoredAttachment[] = [];
	let warning: string | undefined;
	if (outboundAttachments.length) {
		try {
			attachmentData = await storeAttachments(env.BUCKET, messageId, outboundAttachments);
		} catch (e) {
			console.error("Attachment archive failed:", (e as Error).message);
			warning = "Sent, but the attachments could not be archived.";
		}
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			cc: cc.length ? cc.join(", ").toLowerCase() : null,
			bcc: bcc.length ? bcc.join(", ").toLowerCase() : null,
		},
		attachmentData,
	);

	return {
		status: "sent",
		messageId,
		message: `Email sent to ${params.to}`,
		...(warning ? { warning } : {}),
	};
}
