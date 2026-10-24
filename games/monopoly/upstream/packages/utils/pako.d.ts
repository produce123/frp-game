declare module "pako" {
	interface GzipOptions {
		level?: number;
		to?: "string" | "Uint8Array";
	}

	interface UngzipOptions {
		to?: "string" | "Uint8Array";
	}

	function gzip(data: Uint8Array, options?: GzipOptions): Uint8Array;
	function ungzip(data: Uint8Array, options?: UngzipOptions): Uint8Array;

	const pako: {
		gzip: typeof gzip;
		ungzip: typeof ungzip;
	};

	export default pako;
}
