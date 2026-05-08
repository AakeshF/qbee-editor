/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

const QBEE_CHAT_VIEW_ID = 'workbench.view.qbee.chat';
const FIRST_RUN_KEY = 'qbee.firstRunOpened';
const FIRST_RUN_DELAY_MS = 1500;

/**
 * On the very first launch of QBee on this profile, open the QBee panel so the
 * AI dashboard is the visible identity of the editor — not a hidden sidebar
 * users have to discover. The SPA shows the Dashboard tab on first launch
 * (qbee.welcomed.v1 flag in localStorage).
 *
 * Subsequent launches do nothing — power users who closed the panel
 * intentionally are not pestered.
 */
export class QBeeFirstRunOpener extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'qbee.firstRunOpener';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		const opened = this.storageService.getBoolean(FIRST_RUN_KEY, StorageScope.PROFILE, false);
		if (opened) {
			return;
		}
		// Mark before opening so a crash mid-open doesn't cause it to retry on
		// every launch.
		this.storageService.store(FIRST_RUN_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		// Defer briefly so we don't compete with the workbench's own startup
		// view restoration.
		setTimeout(() => {
			void this.viewsService.openView(QBEE_CHAT_VIEW_ID, true).catch(() => undefined);
		}, FIRST_RUN_DELAY_MS);
	}
}
