/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

// Snapshot of what the user is currently looking at. Mirrors the shared/src/api.ts
// EditorContext shape but kept as a structural type here to avoid pulling shared/
// into the editor build.
interface EditorContextSnapshot {
	activeFile?: string;
	selection?: {
		startLine: number;
		endLine: number;
		text: string;
	};
	cursorLine?: number;
	openFiles?: string[];
}

const SELECTION_DEBOUNCE_MS = 150;
const SELECTION_TEXT_MAX_BYTES = 64 * 1024;
const OPEN_FILES_MAX = 50;

/**
 * Pushes editor state (active file, selection, cursor, open tabs) to the QBee
 * SPA via webview postMessage on every relevant change. The SPA forwards it as
 * `editorContext` on /api/chat and /api/agent/run requests so the model knows
 * what the user is looking at.
 */
export class EditorContextBridge extends Disposable {

	private readonly selectionListener = this._register(new MutableDisposable());
	private pendingPushHandle: number | undefined;

	constructor(
		private readonly send: (message: { type: 'editor_state_update'; payload: EditorContextSnapshot }) => void,
		private readonly workspaceRoot: string,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly groupsService: IEditorGroupsService,
	) {
		super();

		this._register(editorService.onDidActiveEditorChange(() => {
			this.rebindSelectionListener();
			this.scheduleImmediatePush();
		}));

		this._register(editorService.onDidEditorsChange(() => this.scheduleImmediatePush()));

		this.rebindSelectionListener();
		this.scheduleImmediatePush();
	}

	override dispose(): void {
		if (this.pendingPushHandle !== undefined) {
			clearTimeout(this.pendingPushHandle);
			this.pendingPushHandle = undefined;
		}
		super.dispose();
	}

	private rebindSelectionListener(): void {
		const editor = this.editorService.activeTextEditorControl;
		if (!isCodeEditor(editor)) {
			this.selectionListener.clear();
			return;
		}
		this.selectionListener.value = editor.onDidChangeCursorSelection(() => this.scheduleDebouncedPush());
	}

	private scheduleImmediatePush(): void {
		if (this.pendingPushHandle !== undefined) {
			clearTimeout(this.pendingPushHandle);
		}
		this.pendingPushHandle = setTimeout(() => {
			this.pendingPushHandle = undefined;
			this.push();
		}, 0) as unknown as number;
	}

	private scheduleDebouncedPush(): void {
		if (this.pendingPushHandle !== undefined) {
			clearTimeout(this.pendingPushHandle);
		}
		this.pendingPushHandle = setTimeout(() => {
			this.pendingPushHandle = undefined;
			this.push();
		}, SELECTION_DEBOUNCE_MS) as unknown as number;
	}

	private push(): void {
		this.send({ type: 'editor_state_update', payload: this.snapshot() });
	}

	private snapshot(): EditorContextSnapshot {
		const result: EditorContextSnapshot = {};

		const editor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(editor)) {
			const model = editor.getModel();
			if (model) {
				result.activeFile = this.toRelativePath(model.uri.fsPath);
			}
			const selection = editor.getSelection();
			if (selection && !selection.isEmpty() && model) {
				const text = model.getValueInRange(selection);
				if (text.length <= SELECTION_TEXT_MAX_BYTES) {
					result.selection = {
						startLine: selection.startLineNumber - 1,
						endLine: selection.endLineNumber - 1,
						text,
					};
				}
			}
			const position = editor.getPosition();
			if (position) {
				result.cursorLine = position.lineNumber - 1;
			}
		} else {
			// Non-code editor pane (settings, welcome, etc.) — still report the resource if present.
			const resource = this.editorService.activeEditor?.resource;
			if (resource && resource.scheme === 'file') {
				result.activeFile = this.toRelativePath(resource.fsPath);
			}
		}

		const seen = new Set<string>();
		const openFiles: string[] = [];
		for (const group of this.groupsService.groups) {
			for (const editorInput of group.editors) {
				const resource = editorInput.resource;
				if (!resource || resource.scheme !== 'file') {
					continue;
				}
				const relative = this.toRelativePath(resource.fsPath);
				if (seen.has(relative)) {
					continue;
				}
				seen.add(relative);
				openFiles.push(relative);
				if (openFiles.length >= OPEN_FILES_MAX) {
					break;
				}
			}
			if (openFiles.length >= OPEN_FILES_MAX) {
				break;
			}
		}
		if (openFiles.length > 0) {
			result.openFiles = openFiles;
		}

		return result;
	}

	private toRelativePath(absolute: string): string {
		if (!this.workspaceRoot) {
			return absolute;
		}
		const root = this.workspaceRoot.endsWith('/') ? this.workspaceRoot : this.workspaceRoot + '/';
		return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
	}
}
