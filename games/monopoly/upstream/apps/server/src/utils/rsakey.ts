import crypto from "crypto";

export const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: {
		type: "spki",
		format: "pem",
	},
	privateKeyEncoding: {
		type: "pkcs8",
		format: "pem",
	},
});

export const encryptionKey = crypto.randomBytes(32).toString("hex");
