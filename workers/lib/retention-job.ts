// Daily 24-month retention purge (#345). Runs from the Worker's scheduled() handler.
// Mode: RETENTION_DRY_RUN must be the exact string "false" to delete anything. Otherwise dry run.

import type { Env } from "../types";
import {
	buildReport,
	groupThreads,
	retentionMode,
	threadsToPurge,
	type RetentionReport,
	type RetentionRow,
} from "./retention";

const DEFAULT_RETENTION_DAYS = 730;
const R2_DELETE_BATCH = 500;

/** RETENTION_MAILBOXES may arrive as a JSON array (wrangler var) or a comma-separated string. */
export function retentionMailboxes(env: Env): string[] {
	const raw: unknown = env.RETENTION_MAILBOXES;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	return list.map((m) => String(m).trim()).filter((m) => m.length > 0);
}

/** Fail closed: an unparsable RETENTION_DAYS throws instead of guessing a cutoff. */
export function retentionDays(env: Env): number {
	const raw = env.RETENTION_DAYS as unknown;
	if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`RETENTION_DAYS must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return n;
}

export async function runRetentionPurge(env: Env, now: number = Date.now()): Promise<RetentionReport[]> {
	const mode = retentionMode(env as { RETENTION_DRY_RUN?: unknown });
	const dryRun = mode !== "delete";
	const days = retentionDays(env);
	const day = new Date(now).toISOString().slice(0, 10);
	const reports: RetentionReport[] = [];
	const failures: string[] = [];

	for (const mailbox of retentionMailboxes(env)) {
		try {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
			const rows = (await stub.listRetentionRows()) as RetentionRow[];
			const threads = groupThreads(rows);
			const report = buildReport({ mailbox, dryRun, now, retentionDays: days, threads });

			await env.BUCKET.put(`retention-reports/${mailbox}/${day}.json`, JSON.stringify(report, null, 2), {
				httpMetadata: { contentType: "application/json" },
			});

			// The only path to deletion. Blobs first, then rows: a crash in between leaves
			// rows pointing at missing blobs, and a re-run deletes them. Never orphaned blobs.
			if (mode === "delete") {
				const doomed = threadsToPurge(threads, now, days).flatMap((t) => t.ids);
				const keys = await stub.attachmentKeysFor(doomed);
				for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
					await env.BUCKET.delete(keys.slice(i, i + R2_DELETE_BATCH));
				}
				for (let i = 0; i < doomed.length; i += R2_DELETE_BATCH) {
					await stub.purgeEmails(doomed.slice(i, i + R2_DELETE_BATCH));
				}
			}

			reports.push(report);
			console.log(
				`[retention] ${mailbox} dryRun=${dryRun} scanned=${report.threadsScanned} ` +
					`threads=${report.threadsToPurge} messages=${report.messagesToPurge} ` +
					`attachments=${report.attachmentsToPurge} report=retention-reports/${mailbox}/${day}.json`,
			);
		} catch (e) {
			failures.push(mailbox);
			console.error(`[retention] ${mailbox} failed:`, (e as Error).message);
		}
	}

	if (failures.length > 0) {
		throw new Error(`retention purge failed for: ${failures.join(", ")}`);
	}
	return reports;
}
