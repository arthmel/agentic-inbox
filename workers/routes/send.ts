// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { storeAttachments, type StoredAttachment } from "../lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

export const SENT_ARCHIVE_WARNING = "Sent, but the copy could not be saved to Sent.";

// Runs after a successful send. Never throws: the mail is already out, so an archive
// error must not reach the client as a failure (a retry would send it twice).
// If R2 fails, the Sent row is still saved with no attachments (it counts toward the rate limit).
// Returns false when any part of the archive failed.
export async function archiveAfterSend(
	bucket: Env["BUCKET"],
	messageId: string,
	attachments: Parameters<typeof storeAttachments>[2],
	saveSent: (attachmentData: StoredAttachment[]) => Promise<unknown>,
): Promise<boolean> {
	let archived = true;
	let attachmentData: StoredAttachment[] = [];
	try {
		attachmentData = await storeAttachments(bucket, messageId, attachments);
	} catch (e) {
		archived = false;
		console.error("Sent, but archiving failed:", (e as Error).message);
	}
	try {
		await saveSent(attachmentData);
	} catch (e) {
		archived = false;
		console.error("Sent, but archiving failed:", (e as Error).message);
	}
	return archived;
}

export function sentResponse(messageId: string, archived: boolean) {
	return archived
		? { id: messageId, status: "sent" }
		: { id: messageId, status: "sent", warning: SENT_ARCHIVE_WARNING };
}

export async function handleSendEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	// Send first, store second: the hourly/daily rate limit counts Sent rows,
	// so a failed delivery must leave no Sent row behind.
	try {
		await sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		});
	} catch (e) {
		return c.json({ error: `Failed to send email: ${(e as Error).message}` }, 502);
	}

	const archived = await archiveAfterSend(c.env.BUCKET, messageId, attachments, (attachmentData) =>
		stub.createEmail(Folders.SENT, {
			id: messageId, subject, sender: fromEmail, recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(), body: html || text || "",
			in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
			thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
		}, attachmentData),
	);

	return c.json(sentResponse(messageId, archived), 202);
}
