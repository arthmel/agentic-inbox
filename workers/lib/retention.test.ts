// Tests for the pure 24-month retention logic (#345).
// Run: node --test --experimental-strip-types workers/lib/retention.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	buildReport,
	groupThreads,
	retentionMode,
	threadsToPurge,
	type RetentionRow,
} from "./retention.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T00:00:00Z");
const RETENTION_DAYS = 730;

function ago(days: number): string {
	return new Date(NOW - days * DAY).toISOString();
}

function row(overrides: Partial<RetentionRow> & { id: string }): RetentionRow {
	return {
		id: overrides.id,
		date: overrides.date ?? ago(1),
		subject: overrides.subject ?? "Enquiry",
		folder: overrides.folder ?? "inbox",
		in_reply_to: overrides.in_reply_to ?? null,
		email_references: overrides.email_references ?? null,
		message_id: overrides.message_id ?? null,
		thread_id: overrides.thread_id ?? null,
		attachment_count: overrides.attachment_count ?? 0,
	};
}

describe("age cutoff", () => {
	test("thread whose newest message is 731 days old is purged", () => {
		const rows = [row({ id: "a", date: ago(731) })];
		const purge = threadsToPurge(groupThreads(rows), NOW, RETENTION_DAYS);
		assert.equal(purge.length, 1);
	});

	test("thread whose newest message is 729 days old is kept", () => {
		const rows = [row({ id: "a", date: ago(729) })];
		const purge = threadsToPurge(groupThreads(rows), NOW, RETENTION_DAYS);
		assert.equal(purge.length, 0);
	});

	test("old enquiry + reply 10 days ago in same thread keeps the whole thread", () => {
		const rows = [
			row({ id: "enquiry", date: ago(800), message_id: "<m1@x>" }),
			row({
				id: "reply",
				date: ago(10),
				folder: "sent",
				in_reply_to: "<m1@x>",
				thread_id: "<m1@x>",
			}),
		];
		const threads = groupThreads(rows);
		assert.equal(threads.length, 1);
		assert.equal(threadsToPurge(threads, NOW, RETENTION_DAYS).length, 0);
	});
});

describe("threading", () => {
	test("groups via in_reply_to", () => {
		const rows = [
			row({ id: "root", date: ago(900), message_id: "<root@x>" }),
			row({ id: "child", date: ago(850), in_reply_to: "<root@x>" }),
			row({ id: "unrelated", date: ago(850), message_id: "<other@x>" }),
		];
		const threads = groupThreads(rows);
		assert.equal(threads.length, 2);
		const grouped = threads.find((t) => t.messageCount === 2);
		assert.ok(grouped, "root + child form one thread");
		assert.deepEqual([...grouped.ids].sort(), ["child", "root"]);
	});

	test("groups via email_references (JSON array)", () => {
		const rows = [
			row({ id: "first", date: ago(900), message_id: "<a@x>" }),
			row({ id: "third", date: ago(850), message_id: "<c@x>", email_references: JSON.stringify(["<a@x>", "<b@x>"]) }),
			row({ id: "lone", date: ago(850) }),
		];
		const threads = groupThreads(rows);
		assert.equal(threads.length, 2);
		assert.equal(threads.find((t) => t.messageCount === 2)?.ids.length, 2);
	});

	test("a message with no links is its own thread", () => {
		const threads = groupThreads([row({ id: "solo" })]);
		assert.equal(threads.length, 1);
		assert.equal(threads[0].messageCount, 1);
	});
});

describe("bad dates are never purged", () => {
	test("unparsable date keeps the thread", () => {
		const rows = [row({ id: "bad", date: "not-a-date" })];
		assert.equal(threadsToPurge(groupThreads(rows), NOW, RETENTION_DAYS).length, 0);
	});

	test("empty date keeps the thread", () => {
		const rows = [row({ id: "empty", date: "" }), row({ id: "null", date: null })];
		assert.equal(threadsToPurge(groupThreads(rows), NOW, RETENTION_DAYS).length, 0);
	});

	test("one unparsable message keeps its whole thread", () => {
		const rows = [
			row({ id: "old", date: ago(900), message_id: "<z@x>" }),
			row({ id: "bad", date: "garbage", in_reply_to: "<z@x>" }),
		];
		assert.equal(threadsToPurge(groupThreads(rows), NOW, RETENTION_DAYS).length, 0);
	});
});

describe("report", () => {
	test("has counts, cutoff, and no sender or body fields", () => {
		const rows = [
			row({ id: "old", date: ago(800), subject: "Hi", attachment_count: 2 }),
			row({ id: "new", date: ago(5) }),
		];
		const report = buildReport({
			mailbox: "info@sepnets.io",
			dryRun: true,
			now: NOW,
			retentionDays: RETENTION_DAYS,
			threads: groupThreads(rows),
		});
		assert.equal(report.mailbox, "info@sepnets.io");
		assert.equal(report.dryRun, true);
		assert.equal(report.threadsScanned, 2);
		assert.equal(report.threadsToPurge, 1);
		assert.equal(report.messagesToPurge, 1);
		assert.equal(report.attachmentsToPurge, 2);
		assert.equal(report.oldestKeptDate, ago(5).slice(0, 10));
		assert.equal(typeof report.cutoff, "string");
		const json = JSON.stringify(report);
		assert.ok(!/sender|recipient|body|from|to"/i.test(json.replace(/"oldestKeptDate"|"threadNewestDate"/g, "")), "no sender/body fields");
	});

	test("sample is capped at 20 entries", () => {
		const rows = Array.from({ length: 30 }, (_, i) => row({ id: `m${i}`, date: ago(800 + i) }));
		const report = buildReport({
			mailbox: "info@sepnets.io",
			dryRun: true,
			now: NOW,
			retentionDays: RETENTION_DAYS,
			threads: groupThreads(rows),
		});
		assert.equal(report.threadsToPurge, 30);
		assert.equal(report.sample.length, 20);
	});

	test("sample subjects are truncated to 60 chars", () => {
		const long = "x".repeat(200);
		const rows = [row({ id: "old", date: ago(800), subject: long })];
		const report = buildReport({
			mailbox: "info@sepnets.io",
			dryRun: true,
			now: NOW,
			retentionDays: RETENTION_DAYS,
			threads: groupThreads(rows),
		});
		assert.equal(report.sample.length, 1);
		assert.ok(report.sample[0].subject.length <= 60);
		assert.equal(report.sample[0].messageCount, 1);
		assert.ok(!("sender" in report.sample[0]));
	});
});

describe("dry-run gate", () => {
	test("only the exact string 'false' enables deletion", () => {
		assert.equal(retentionMode({ RETENTION_DRY_RUN: "false" }), "delete");
	});

	test("everything else is dry run", () => {
		for (const value of [undefined, "", "true", "False", "0", "no", "FALSE", " false", "true "]) {
			assert.equal(
				retentionMode({ RETENTION_DRY_RUN: value as string | undefined }),
				"dry-run",
				`value ${JSON.stringify(value)} must be dry-run`,
			);
		}
		assert.equal(retentionMode({}), "dry-run");
	});
});
