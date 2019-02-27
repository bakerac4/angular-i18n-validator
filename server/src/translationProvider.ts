import { TextDocument, DiagnosticSeverity, Diagnostic, Connection, TextDocuments, Hover, TextDocumentPositionParams, Range } from 'vscode-languageserver';
import { Project, ProjectTranslation } from './project.model';

import matcher = require('matcher');

export class TranslationProvider {
	private projects: Project[] = [];
	private translations: Translation[] = [];
	private words = {};

	constructor(private connection: Connection, private documents: TextDocuments) { }

	public assignProjects(projects: Project[]): any {
		this.projects = projects;
		this.assignProjectToTranslation();
	}

	public onTranslationLoaded(): void {
		this.assignProjectToTranslation();
		this.validateHtmlDocuments();
	}

	public processFile(textDocument: TextDocument): void {
		if (this.isTranslationFile(textDocument)) {
			this.processTranslationFile(textDocument);
		} else if (this.isHtmlFile(textDocument)) {
			this.processHtmlFile(textDocument);
		}
	}

	public calculateHover(param: TextDocumentPositionParams): Hover {
		let hover: Hover = null;
		const doc = this.documents.get(param.textDocument.uri);
		if (doc) {
			const activeWords = <IdRange[]>this.words[param.textDocument.uri];
			if (activeWords && activeWords.length > 0) {
				const positin = doc.offsetAt(param.position);
				const expectedWord = activeWords.find(w => {
					return positin >= w.start
						&& positin <= w.end;
				});
				if (expectedWord) {
					const trans = this.getSupportedTranslations(doc);
					if (trans.length > 0) {
						const values = trans.map(t => {
							const findTrans = t.units.find(u => u.id === expectedWord.id);
							return {
								label: t.project.label,
								word: findTrans && findTrans.target
							};
						});

						return <Hover>{
							range: expectedWord.range,
							contents: values.map(v => v.word).join(',')
						};
					}
				}
			}
		}
		return null;
	}

	private processHtmlFile(textDocument: TextDocument): void {
		if (!this.projects || Object.keys(this.translations).length === 0) {
			return;
		}
		this.doValidate(textDocument);
	}

	private validateHtmlDocuments(): void {
		this.documents.all().forEach(textDocument => {
			if (this.isHtmlFile(textDocument)) {
				this.processHtmlFile(textDocument);
			}
		});
	}

	private isTranslationFile(textDocument: TextDocument): boolean {
		return textDocument.languageId === 'xml' &&
			textDocument.uri.endsWith('.xlf');
	}

	private isHtmlFile(textDocument: TextDocument): boolean {
		return textDocument.languageId === 'html';
	}

	private doValidate(textDocument: TextDocument): void {
		let text = textDocument.getText();
		let pattern = /i18n.+["|']@@(.+?)["|']/g;
		let m: RegExpExecArray | null;

		const trans = this.getSupportedTranslations(textDocument);
		if (trans.length === 0) { return; }

		this.words[textDocument.uri] = [];

		let diagnostics: Diagnostic[] = [];
		while (m = pattern.exec(text)) {
			const group = m[1];
			const value = <IdRange>{
				start: m.index,
				end: m.index + m[0].length,
				id: m[1],
				range: {
					start: textDocument.positionAt(m.index),
					end: textDocument.positionAt(m.index + m[0].length)
				}
			};
			this.words[textDocument.uri].push(value);

			const missingTranslations = trans.filter(t => {
				const unit = t.units.find(u => u.id === group);
				return !unit;
			});

			if (missingTranslations.length === 0) {
				continue;
			}

			const missed = missingTranslations.map(m => m.project.label).join(', ');

			let diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: textDocument.positionAt(m.index),
					end: textDocument.positionAt(m.index + m[0].length)
				},
				message: `Missed translation in '${missed}' project(-s)`
			};

			diagnostics.push(diagnostic);
		}

		// Send the computed diagnostics to VSCode.
		this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	}

	private processTranslationFile(textDocument: TextDocument): void {
		const existTrans = this.translations.find(t => t.uri === textDocument.uri);
		const parser = new TranslationParser();
		const units = parser.getTransUnits(textDocument);
		if (!existTrans) {
			const proj = this.getProjectForTranslation(textDocument.uri);
			const trans = <Translation>{
				uri: textDocument.uri,
				units: units,
				project: proj
			};
			this.translations.push(trans);
		}
		else {
			existTrans.units = units;
		}
		this.validateHtmlDocuments();
	}

	private getProjectForTranslation(uri: string): Project {
		if (!this.projects) {
			return null;
		}
		const proj = this.projects.find(p => {
			if (uri.indexOf(p.translation.i18nFile) >= 0) {
				return true;
			}
		});
		return proj;
	}

	private assignProjectToTranslation(): void {
		if (this.translations.length === 0 || this.projects.length === 0) {
			return;
		}
		this.translations.forEach(trans => {
			const proj = this.getProjectForTranslation(trans.uri);
			trans.project = proj;
		});
	}

	private getSupportedTranslations(textDocument: TextDocument): Translation[] {
		const projects = this.projects.filter(p => this.isFileBelongsProject(p, textDocument.uri));
		let trans = [];
		if (projects.length === 0) {
			return trans;
		}
		projects.forEach(p => {
			const selectedTrans = this.translations.find(t => {
				if (!t.project) {
					return false;
				}
				return t.project.label === p.label;
			});
			if (selectedTrans) {
				trans.push(selectedTrans);
			}
		});
		return trans;
	}

	private isFileBelongsProject(project: Project, uri: string): boolean {
		if (uri.indexOf(project.root) < 0) {
			return false;
		}
		const fileShouldBeExcluded = project.exclude.some(e => {
			const matched = matcher.isMatch(uri, e + '*');
			return matched;
		});
		return !fileShouldBeExcluded;
	}
}

export class TranslationParser {
	private splitUnitsRegex = /<trans-unit(.|\s|\n)*?<\/trans-unit>/gm;
	private idRegex = /id=["|'](.+?)["|']/m;
	private sourceRegex = /<source>((.|\s|\n)*?)<\/source>/m;
	private targetRegex = /<target>((.|\s|\n)*?)<\/target>/m;

	public getTransUnits(document: TextDocument): TransUnit[] {
		try {
			let unitBlocks = this.getTransUnitsBlocks(document);
			let units = this.processUnitBlocks(unitBlocks);
			return units;
		}
		catch (ex) {
			console.log(ex.message);
		}

		return [];
	}

	private getTransUnitsBlocks(document: TextDocument): RegExpExecArray[] {
		let units = [];

		let m: RegExpExecArray | null;
		const text = document.getText();
		while (m = this.splitUnitsRegex.exec(text)) {
			units.push(m);
		}
		return units;
	}

	private processUnitBlocks(blocks: RegExpExecArray[]): TransUnit[] {
		let units: TransUnit[] = [];
		blocks.forEach(value => {
			const text = value[0];
			const id = this.idRegex.exec(text);
			if (!id) {
				return;
			}
			const source = this.sourceRegex.exec(text);
			const target = this.targetRegex.exec(text);
			units.push(<TransUnit>{
				id: id[1],
				source: source && source[1],
				target: target && target[1],
				sourceIndex: source && source.index,
				targetIndex: target && target.index
			});
		});
		return units;
	}
}

export interface TransUnit {
	id: string;
	source: string;
	target: string;
	sourceIndex: number;
	targetIndex: number;
}

export interface Translation {
	uri: string;
	units: TransUnit[];
	project: Project;
}

export interface IdRange {
	start: number;
	end: number;
	id: string;
	range: Range;
}