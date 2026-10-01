import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
} from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSigner } from "@gitaalekhyapaul/raziel-sdk-ts";
import { privateDirectory, privateRead } from "./storage.ts";

export async function loadIdentity(root: string) {
	await privateDirectory(root);
	const path = join(root, "identity.pem");
	try {
		await privateRead(path, 4096);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const pair = generateKeyPairSync("ed25519");
		const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
		try {
			const file = await open(path, "wx", 0o600);
			try {
				await file.writeFile(pem);
				await file.sync();
			} finally {
				await file.close();
			}
		} catch (writeError) {
			if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
				throw writeError;
		}
	}
	const key = createPrivateKey(await privateRead(path, 4096));
	if (key.asymmetricKeyType !== "ed25519")
		throw new Error("INVALID_AGENT_IDENTITY");
	const publicJwk = createPublicKey(key).export({ format: "jwk" });
	const publicKey = new Uint8Array(Buffer.from(publicJwk.x!, "base64url"));
	const signer: AgentSigner = {
		publicKey,
		async sign(message) {
			return new Uint8Array(sign(null, message, key));
		},
	};
	return {
		signer,
		public: {
			publicKey: Buffer.from(publicKey).toString("hex"),
			keyThumbprint: createHash("sha256").update(publicKey).digest("hex"),
		},
	};
}
