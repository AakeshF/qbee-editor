/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QBee edit applier — receives apply_edit messages from the SPA webview and applies them
// via IBulkEditService. The agent never writes to disk; this is the only path that does.

import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export type ApplyEditRequest = {
	type: 'apply_edit';
	requestId: string;
	path: string;
	oldContent: string;
	newContent: string;
};

export type ApplyEditResponse = {
	type: 'edit_applied';
	requestId: string;
	success: boolean;
	error?: string;
};

export class EditApplier {
	constructor(
		private readonly bulkEditService: IBulkEditService,
		private readonly fileService: IFileService,
		private readonly contextService: IWorkspaceContextService,
	) {}

	async apply(req: ApplyEditRequest): Promise<ApplyEditResponse> {
		const folder = this.contextService.getWorkspace().folders[0];
		if (!folder) {
			return { type: 'edit_applied', requestId: req.requestId, success: false, error: 'no workspace folder open' };
		}

		// Reject paths that try to escape the workspace root.
		const target = URI.joinPath(folder.uri, req.path);
		const folderPath = folder.uri.path.replace(/\/$/, '');
		if (target.path !== folderPath && !target.path.startsWith(folderPath + '/')) {
			return { type: 'edit_applied', requestId: req.requestId, success: false, error: `path '${req.path}' resolves outside the workspace` };
		}

		try {
			const exists = await this.fileService.exists(target);
			const edits: (ResourceTextEdit | ResourceFileEdit)[] = [];

			if (!exists) {
				// New file: create with the contents directly. Skipping a no-op TextEdit
				// because IBulkEditService applies file edits before text edits.
				edits.push(new ResourceFileEdit(undefined, target, { contents: Promise.resolve(VSBuffer.fromString(req.newContent)), overwrite: false }));
			} else {
				// Whole-file replace. We treat the unified diff as opaque — the agent
				// already produced full new contents, so the simplest correct thing is
				// to overwrite the entire file with the new content.
				const model = await this.fileService.readFile(target);
				const lines = model.value.toString().split('\n').length;
				const lastLineLen = (model.value.toString().split('\n').pop() ?? '').length;
				const fullRange = new Range(1, 1, lines, lastLineLen + 1);
				edits.push(new ResourceTextEdit(target, { range: fullRange, text: req.newContent }));
			}

			const result = await this.bulkEditService.apply(edits, { quotableLabel: 'QBee agent edit' });
			if (!result.isApplied) {
				return { type: 'edit_applied', requestId: req.requestId, success: false, error: 'edit was not applied (may have been cancelled)' };
			}
			return { type: 'edit_applied', requestId: req.requestId, success: true };
		} catch (err) {
			return { type: 'edit_applied', requestId: req.requestId, success: false, error: (err as Error).message };
		}
	}
}
