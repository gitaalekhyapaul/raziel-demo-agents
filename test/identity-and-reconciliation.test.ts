import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { loadIdentity } from "../src/identity.ts";
import {
	lookupFromRow,
	reconcile,
	validateResult,
	type LedgerRow,
} from "../src/reconciliation.ts";

test("separate identities survive restart and sign with their retained keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "raziel-identities-"));
	try {
		const a = await loadIdentity(join(root, "a"));
		const restart = await loadIdentity(join(root, "a"));
		const b = await loadIdentity(join(root, "b"));
		assert.deepEqual(a.public, restart.public);
		assert.notEqual(a.public.publicKey, b.public.publicKey);
		assert.equal(
			(await stat(join(root, "a", "identity.pem"))).mode & 0o777,
			0o600,
		);
		const message = Buffer.from("synthetic signature check");
		const key = createPublicKey({
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: Buffer.from(a.signer.publicKey).toString("base64url"),
			},
			format: "jwk",
		});
		assert.equal(
			verify(null, message, key, await restart.signer.sign(message)),
			true,
		);
		assert.equal(
			verify(null, message, key, await b.signer.sign(message)),
			false,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const row: LedgerRow = {
	transactionId: "processor-001",
	occurredAt: "2026-10-01T10:00:00Z",
	amountMinor: "12500",
	currency: "SGD",
	merchantReference: "recon-exact-001",
	reconciliationStatus: "UNMATCHED",
	sourceRecordDigest: "a".repeat(64),
};
test("stored row matching handles exact, missing, ambiguous, currency, and integer differences", () => {
	const lookup = lookupFromRow(row);
	const bank = { ...row, transactionId: "bank-001" };
	const exact = reconcile(lookup, [bank], "receipt-001");
	assert.equal(exact.status, "matched");
	assert.equal(exact.amountDifferenceMinor, "0");
	assert.deepEqual(validateResult(exact), exact);
	assert.equal(reconcile(lookup, [], "receipt-002").status, "not_found");
	assert.equal(
		reconcile(
			lookup,
			[bank, { ...bank, transactionId: "bank-002" }],
			"receipt-003",
		).status,
		"ambiguous",
	);
	assert.equal(
		reconcile(lookup, [{ ...bank, currency: "USD" }], "receipt-004").status,
		"not_found",
	);
	assert.equal(
		reconcile(lookup, [{ ...bank, amountMinor: "12600" }], "receipt-005")
			.amountDifferenceMinor,
		"100",
	);
	assert.equal(
		reconcile(
			{ ...lookup, amountMinor: "9007199254740993" },
			[{ ...bank, amountMinor: "9007199254740994" }],
			"receipt-006",
		).amountDifferenceMinor,
		"1",
	);
	assert.throws(() => validateResult({ ...exact, rawBankRecord: bank }));
});
