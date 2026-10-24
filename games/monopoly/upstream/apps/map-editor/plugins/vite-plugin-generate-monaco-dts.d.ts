declare function generateMonacoDTS(): {
	name: string;
	buildStart(): void;
	configureServer(server: any): void;
};
