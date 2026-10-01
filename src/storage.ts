import { randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export class AppError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status = 400) {
		super(code);
		this.code = code;
		this.status = status;
	}
}

export async function privateDirectory(path: string) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (
		!stat.isDirectory() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new AppError("PRIVATE_STORAGE_INVALID", 503);
}

export async function privateRead(
	path: string,
	maximum = 4 * 1024 * 1024,
): Promise<string> {
	const stat = await lstat(path);
	if (
		!stat.isFile() ||
		(stat.mode & 0o077) !== 0 ||
		stat.size > maximum ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new AppError("PRIVATE_STORAGE_INVALID", 503);
	return readFile(path, "utf8");
}

export async function atomicWrite(path: string, value: string) {
	if (Buffer.byteLength(value) > 4 * 1024 * 1024)
		throw new AppError("STATE_CAPACITY_EXCEEDED", 409);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(value);
		await file.sync();
		await file.close();
		await rename(temporary, path);
	} catch (error) {
		await file.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

export class JsonStore<T> {
	readonly path: string;
	readonly initial: () => T;
	#tail: Promise<unknown> = Promise.resolve();
	constructor(root: string, name: string, initial: () => T) {
		this.path = join(root, name);
		this.initial = initial;
	}
	async read(): Promise<T> {
		try {
			return JSON.parse(await privateRead(this.path)) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return this.initial();
			throw error;
		}
	}
	async update<R>(operation: (state: T) => R | Promise<R>): Promise<R> {
		const result = this.#tail.then(async () => {
			const state = await this.read();
			const value = await operation(state);
			await atomicWrite(this.path, JSON.stringify(state));
			return value;
		});
		this.#tail = result.catch(() => {});
		return result;
	}
}
