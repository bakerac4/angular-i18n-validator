import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification} from 'vscode-languageserver';
import { TranslationProvider } from './translationProvider';
import { Project } from './project.model';


let connection = createConnection(ProposedFeatures.all);

let documents: TextDocuments = new TextDocuments();

const translationProvider = new TranslationProvider(connection, documents);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
	hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);

	return {
		capabilities: {
			textDocumentSync: documents.syncKind,
		}
	};
});

connection.onInitialized(async () => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
});

connection.onRequest('rettoua.hoverRequest', (args: any) => {
	return translationProvider.calculateHover(args.url, args.position);
});

connection.onRequest('rettoua.locationsRequest', (args: any) => {
	return translationProvider.calculateLocations(args.url, args.position);
});

documents.onDidChangeContent(async (change) => {
	translationProvider.processFile(change.document);
});

connection.onNotification("custom/projects", (projects: Project[]) => {
	translationProvider.assignProjects(projects);
});

connection.onNotification("custom/translationsLoaded", () => {
	translationProvider.onTranslationLoaded();
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();