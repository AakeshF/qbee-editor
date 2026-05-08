/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { CheckpointStore } from './checkpointStore.js';

class UndoLastAgentRunAction extends Action2 {
	static readonly ID = 'qbee.undoLastAgentRun';

	constructor() {
		super({
			id: UndoLastAgentRunAction.ID,
			title: localize2('qbee.undoLastAgentRun', 'QBee: Undo Last Agent Run'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const contextService = accessor.get(IWorkspaceContextService);
		const bulkEditService = accessor.get(IBulkEditService);
		const notificationService = accessor.get(INotificationService);

		const folder = contextService.getWorkspace().folders[0];
		if (!folder) {
			notificationService.notify({ severity: Severity.Warning, message: localize('qbee.undo.noFolder', 'QBee: no workspace folder open.') });
			return;
		}

		const store = new CheckpointStore(fileService);
		const runId = await store.latestRunId(folder.uri);
		if (!runId) {
			notificationService.notify({ severity: Severity.Info, message: localize('qbee.undo.noRun', 'QBee: no agent run to undo.') });
			return;
		}
		const manifest = await store.readManifest(folder.uri, runId);
		if (!manifest || manifest.files.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('qbee.undo.empty', 'QBee: latest agent run has no recorded changes.') });
			return;
		}

		const edits: (ResourceTextEdit | ResourceFileEdit)[] = [];
		const restored: string[] = [];
		const removed: string[] = [];

		for (const entry of manifest.files) {
			const target = URI.joinPath(folder.uri, ...entry.path.split('/'));
			if (!entry.existed) {
				// File didn't exist pre-run, so undo means deleting it.
				if (await fileService.exists(target)) {
					edits.push(new ResourceFileEdit(target, undefined, { folder: false }));
					removed.push(entry.path);
				}
				continue;
			}
			const snapshot = await store.readSnapshot(folder.uri, runId, entry.path);
			if (!snapshot) {
				continue;
			}
			const exists = await fileService.exists(target);
			if (!exists) {
				// File was deleted during the run — recreate it from snapshot.
				edits.push(new ResourceFileEdit(undefined, target, { contents: Promise.resolve(snapshot), overwrite: false }));
				restored.push(entry.path);
				continue;
			}
			// File exists — overwrite with snapshot text.
			const current = await fileService.readFile(target);
			const text = current.value.toString();
			const lines = text.split('\n').length;
			const lastLineLen = (text.split('\n').pop() ?? '').length;
			const fullRange = new Range(1, 1, lines, lastLineLen + 1);
			edits.push(new ResourceTextEdit(target, { range: fullRange, text: snapshot.toString() }));
			restored.push(entry.path);
		}

		if (edits.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('qbee.undo.nothing', 'QBee: nothing to undo (files already match the pre-run state).') });
			return;
		}

		const result = await bulkEditService.apply(edits, { quotableLabel: 'QBee undo agent run' });
		if (!result.isApplied) {
			notificationService.notify({ severity: Severity.Warning, message: localize('qbee.undo.cancelled', 'QBee undo was cancelled.') });
			return;
		}
		const restoredCount = restored.length;
		const removedCount = removed.length;
		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'qbee.undo.done',
				'QBee: undo complete. Restored {0} file(s), removed {1} agent-created file(s).',
				restoredCount,
				removedCount,
			),
		});
	}
}

export function registerUndoLastAgentRun(): void {
	registerAction2(UndoLastAgentRunAction);
}
