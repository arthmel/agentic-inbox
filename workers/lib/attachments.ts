// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

const MAX_FILENAME_LENGTH = 200;

/**
 * Make an attachment filename safe for the outgoing MIME part and the R2 key.
 * Used for both what is sent and what is stored, so they always match.
 */
export function sanitizeAttachmentFilename(name: string): string {
	let safe = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
	if (safe === "" || safe === "." || safe === "..") return "untitled";
	if (safe.length > MAX_FILENAME_LENGTH) {
		const dot = safe.lastIndexOf(".");
		let ext = dot > 0 ? safe.slice(dot) : "";
		if (ext.length > 100) ext = "";
		safe = safe.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
	}
	return safe;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = sanitizeAttachmentFilename(att.filename);
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}
