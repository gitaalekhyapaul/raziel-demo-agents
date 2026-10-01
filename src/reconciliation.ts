import { AppError } from "./storage.ts";

export interface LedgerRow {
	transactionId: string;
	occurredAt: string;
	amountMinor: string;
	currency: string;
	merchantReference?: string;
	accountReference?: string;
	transactionType?: string;
	reconciliationStatus: string;
	sourceRecordDigest: string;
}
export interface Lookup {
	transactionReference: string;
	merchantReference: string;
	amountMinor: string;
	currency: string;
}
export interface SettlementResult {
	status: "matched" | "not_found" | "ambiguous";
	transactionReference: string;
	currency: string;
	evidenceReceiptId: string;
	candidateCount: number;
	settlementReference?: string;
	settlementAmountMinor?: string;
	amountDifferenceMinor?: string;
}
export function text(value: unknown, maximum = 128): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maximum ||
		/\p{Cc}/u.test(value)
	)
		throw new AppError("INVALID_REQUEST");
	return value;
}
export function minor(value: unknown): bigint {
	if (typeof value !== "string" || !/^-?(0|[1-9][0-9]{0,17})$/.test(value))
		throw new AppError("INVALID_AMOUNT");
	return BigInt(value);
}
export function lookupFromRow(row: LedgerRow): Lookup {
	minor(row.amountMinor);
	return validateLookup({
		transactionReference: row.transactionId,
		merchantReference: row.merchantReference,
		amountMinor: row.amountMinor,
		currency: row.currency,
	});
}
export function validateLookup(value: unknown): Lookup {
	const row = value as Record<string, unknown>;
	if (
		!row ||
		Object.keys(row).sort().join(",") !==
			"amountMinor,currency,merchantReference,transactionReference"
	)
		throw new AppError("INVALID_MESSAGE");
	const amountMinor = text(row.amountMinor, 20);
	minor(amountMinor);
	const currency = text(row.currency, 3);
	if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("INVALID_MESSAGE");
	return {
		transactionReference: text(row.transactionReference),
		merchantReference: text(row.merchantReference),
		amountMinor,
		currency,
	};
}
export function reconcile(
	lookup: Lookup,
	bankRows: readonly LedgerRow[],
	receiptId: string,
): SettlementResult {
	const matches = bankRows.filter(
		(row) =>
			row.merchantReference === lookup.merchantReference &&
			row.currency === lookup.currency,
	);
	const base = {
		transactionReference: lookup.transactionReference,
		currency: lookup.currency,
		evidenceReceiptId: text(receiptId),
		candidateCount: matches.length,
	};
	if (!matches.length) return { ...base, status: "not_found" };
	if (matches.length !== 1) return { ...base, status: "ambiguous" };
	const settlement = matches[0]!;
	return {
		...base,
		status: "matched",
		settlementReference: settlement.transactionId,
		settlementAmountMinor: minor(settlement.amountMinor).toString(),
		amountDifferenceMinor: (
			minor(settlement.amountMinor) - minor(lookup.amountMinor)
		).toString(),
	};
}
export function validateResult(value: unknown): SettlementResult {
	const row = value as SettlementResult;
	const keys = [
		"status",
		"transactionReference",
		"currency",
		"evidenceReceiptId",
		"candidateCount",
		"settlementReference",
		"settlementAmountMinor",
		"amountDifferenceMinor",
	];
	if (
		!row ||
		Object.keys(row).some((key) => !keys.includes(key)) ||
		!["matched", "not_found", "ambiguous"].includes(row.status) ||
		!Number.isInteger(row.candidateCount) ||
		row.candidateCount < 0 ||
		row.candidateCount > 100
	)
		throw new AppError("INVALID_MESSAGE");
	text(row.transactionReference);
	text(row.evidenceReceiptId);
	if (!/^[A-Z]{3}$/.test(row.currency)) throw new AppError("INVALID_MESSAGE");
	if (row.status === "matched") {
		if (row.candidateCount !== 1) throw new AppError("INVALID_MESSAGE");
		text(row.settlementReference);
		minor(row.settlementAmountMinor);
		minor(row.amountDifferenceMinor);
	} else if (
		row.settlementReference !== undefined ||
		row.settlementAmountMinor !== undefined ||
		row.amountDifferenceMinor !== undefined ||
		(row.status === "not_found"
			? row.candidateCount !== 0
			: row.candidateCount < 2)
	)
		throw new AppError("INVALID_MESSAGE");
	return structuredClone(row);
}
