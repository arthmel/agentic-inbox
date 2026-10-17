// Pure 24-month retention logic (#345). No Cloudflare imports: unit-tested with node --test.
//
// Unit = thread. A thread is purged when its NEWEST message (any folder) is older than
// retentionDays. Threads are built by union-find over identifiers the existing columns
// already carry: message_id, in_reply_to, email_references, thread_id. A message with no
// links is its own thread. A thread containing any unparsable date is kept (never purge on bad data).

export interface RetentionRow {
	id: string;
	date: string | null;
	subject: string | null;
	folder: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	message_id: string | null;
	thread_id: string | null;
	attachment_count: number;
}

export interface RetentionThread {
	ids: string[];
	messageCount: number;
	attachmentCount: number;
	/** Epoch ms of the newest parsable message, or null when no message has a parsable date. */
	newestMs: number | null;
	hasUnparsableDate: boolean;
	/** Subject of the oldest parsable message (fallback: first row). */
	subject: string;
}

export type RetentionMode = "delete" | "dry-run";

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 20;
const SUBJECT_LIMIT = 60;

function normalizeMessageId(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseReferences(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((v): v is string => typeof v === "string");
		}
		if (typeof parsed === "string") return parsed.split(/\s+/);
		return [];
	} catch {
		return raw.split(/\s+/);
	}
}

function parseDateMs(value: string | null): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

class UnionFind {
	private parent = new Map<string, string>();

	find(key: string): string {
		let root = this.parent.get(key);
		if (root === undefined) {
			this.parent.set(key, key);
			return key;
		}
		while (root !== this.parent.get(root)) root = this.parent.get(root)!;
		// path compression
		let cur = key;
		while (cur !== root) {
			const next = this.parent.get(cur)!;
			this.parent.set(cur, root);
			cur = next;
		}
		return root;
	}

	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

/** Group message rows into threads using the threading identifiers on each row. */
export function groupThreads(rows: RetentionRow[]): RetentionThread[] {
	const uf = new UnionFind();
	const rowKeys = rows.map((r) => {
		const keys: string[] = [`row:${r.id}`];
		const mid = normalizeMessageId(r.message_id);
		const reply = normalizeMessageId(r.in_reply_to);
		const thread = normalizeMessageId(r.thread_id);
		if (mid) keys.push(`mid:${mid}`);
		if (reply) keys.push(`mid:${reply}`);
		if (thread) keys.push(`mid:${thread}`);
		for (const ref of parseReferences(r.email_references)) {
			const n = normalizeMessageId(ref);
			if (n) keys.push(`mid:${n}`);
		}
		for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);
		return keys[0];
	});

	const groups = new Map<string, RetentionRow[]>();
	rows.forEach((r, i) => {
		const root = uf.find(rowKeys[i]);
		const list = groups.get(root);
		if (list) list.push(r);
		else groups.set(root, [r]);
	});

	const threads: RetentionThread[] = [];
	for (const members of groups.values()) {
		let newestMs: number | null = null;
		let oldestMs: number | null = null;
		let oldestSubject: string | null = null;
		let hasUnparsableDate = false;
		let attachmentCount = 0;
		for (const m of members) {
			attachmentCount += m.attachment_count;
			const ms = parseDateMs(m.date);
			if (ms === null) {
				hasUnparsableDate = true;
				continue;
			}
			if (newestMs === null || ms > newestMs) newestMs = ms;
			if (oldestMs === null || ms < oldestMs) {
				oldestMs = ms;
				oldestSubject = m.subject ?? "";
			}
		}
		threads.push({
			ids: members.map((m) => m.id),
			messageCount: members.length,
			attachmentCount,
			newestMs,
			hasUnparsableDate,
			subject: oldestSubject ?? members[0]?.subject ?? "",
		});
	}
	return threads;
}

/** Threads whose newest message is older than the cutoff. Unknown dates are never purged. */
export function threadsToPurge(
	threads: RetentionThread[],
	now: number,
	retentionDays: number,
): RetentionThread[] {
	const cutoff = now - retentionDays * DAY_MS;
	return threads.filter(
		(t) => !t.hasUnparsableDate && t.newestMs !== null && t.newestMs < cutoff,
	);
}

/** Only the literal string "false" enables deletion. Anything else is a dry run. */
export function retentionMode(env: { RETENTION_DRY_RUN?: unknown }): RetentionMode {
	return env.RETENTION_DRY_RUN === "false" ? "delete" : "dry-run";
}

export interface RetentionReport {
	mailbox: string;
	dryRun: boolean;
	cutoff: string;
	threadsScanned: number;
	threadsToPurge: number;
	messagesToPurge: number;
	attachmentsToPurge: number;
	oldestKeptDate: string | null;
	sample: { threadNewestDate: string; messageCount: number; subject: string }[];
}

export function buildReport(opts: {
	mailbox: string;
	dryRun: boolean;
	now: number;
	retentionDays: number;
	threads: RetentionThread[];
}): RetentionReport {
	const { mailbox, dryRun, now, retentionDays, threads } = opts;
	const cutoffMs = now - retentionDays * DAY_MS;
	const purge = threadsToPurge(threads, now, retentionDays);
	const purgeSet = new Set(purge);

	let oldestKeptMs: number | null = null;
	for (const t of threads) {
		if (purgeSet.has(t) || t.newestMs === null) continue;
		if (oldestKeptMs === null || t.newestMs < oldestKeptMs) oldestKeptMs = t.newestMs;
	}

	const sorted = [...purge].sort((a, b) => (a.newestMs ?? 0) - (b.newestMs ?? 0));

	return {
		mailbox,
		dryRun,
		cutoff: new Date(cutoffMs).toISOString(),
		threadsScanned: threads.length,
		threadsToPurge: purge.length,
		messagesToPurge: purge.reduce((n, t) => n + t.messageCount, 0),
		attachmentsToPurge: purge.reduce((n, t) => n + t.attachmentCount, 0),
		oldestKeptDate: oldestKeptMs === null ? null : new Date(oldestKeptMs).toISOString().slice(0, 10),
		sample: sorted.slice(0, SAMPLE_LIMIT).map((t) => ({
			threadNewestDate: new Date(t.newestMs ?? 0).toISOString(),
			messageCount: t.messageCount,
			subject: t.subject.slice(0, SUBJECT_LIMIT),
		})),
	};
}
