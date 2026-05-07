/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QBee in-app updater. Compares product.json version against the latest GitHub
// release; surfaces a notification with a link to the release page if newer.
// AppImage in-place replacement is hard (the running binary is mounted FUSE);
// we open the browser and let the user re-download.

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

const RELEASES_OWNER = 'AakeshF';
const RELEASES_REPO = 'qbee';
const LATEST_API = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`;

type GitHubRelease = {
	tag_name: string;
	html_url: string;
	name: string;
	body: string;
};

class CheckForUpdatesAction extends Action2 {
	static readonly ID = 'qbee.checkForUpdates';
	constructor() {
		super({
			id: CheckForUpdatesAction.ID,
			title: localize2('qbee.checkForUpdates', 'QBee: Check for Updates'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const productService = accessor.get(IProductService);
		const openerService = accessor.get(IOpenerService);

		try {
			const release = await fetchLatestRelease();
			if (!release) {
				notificationService.notify({ severity: Severity.Error, message: localize('qbee.update.fetchFailed', 'QBee: failed to check for updates.') });
				return;
			}
			const current = productService.version || '0.0.0';
			const latest = release.tag_name.replace(/^v/, '');
			if (compareSemver(latest, current) <= 0) {
				notificationService.notify({ severity: Severity.Info, message: localize('qbee.update.upToDate', 'QBee {0} is up to date.', current) });
				return;
			}
			notificationService.notify({
				severity: Severity.Info,
				message: localize('qbee.update.available', 'QBee {0} is available. You are running {1}.', latest, current),
				actions: {
					primary: [{
						id: 'qbee.update.open',
						label: localize('qbee.update.open', 'Open release page'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: async () => { await openerService.open(URI.parse(release.html_url)); },
					}],
				},
			});
		} catch (err) {
			notificationService.notify({ severity: Severity.Error, message: localize('qbee.update.error', 'QBee update check failed: {0}', (err as Error).message) });
		}
	}
}

registerAction2(CheckForUpdatesAction);

// Background contribution: silently check on workbench startup and surface a
// notification only if an update is available. Failures are silent.
export class QBeeUpdateCheckOnStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'qbee.updateCheckOnStartup';
	constructor(
		@INotificationService notificationService: INotificationService,
		@IProductService productService: IProductService,
		@IOpenerService openerService: IOpenerService,
	) {
		super();
		// Defer 10s so we don't compete with the activation barrage.
		setTimeout(async () => {
			try {
				const release = await fetchLatestRelease();
				if (!release) { return; }
				const current = productService.version || '0.0.0';
				const latest = release.tag_name.replace(/^v/, '');
				if (compareSemver(latest, current) <= 0) { return; }
				notificationService.notify({
					severity: Severity.Info,
					message: localize('qbee.update.available', 'QBee {0} is available. You are running {1}.', latest, current),
					actions: {
						primary: [{
							id: 'qbee.update.open',
							label: localize('qbee.update.open', 'Open release page'),
							tooltip: '',
							class: undefined,
							enabled: true,
							run: async () => { await openerService.open(URI.parse(release.html_url)); },
						}],
					},
				});
			} catch {
				// Silent on startup failures.
			}
		}, 10_000);
	}
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
	try {
		const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
		if (!res.ok) { return null; }
		return (await res.json()) as GitHubRelease;
	} catch {
		return null;
	}
}

// Compare two semver-ish strings ("1.2.3" or "1.2.3-beta"). Returns
// negative if a < b, 0 if equal, positive if a > b.
function compareSemver(a: string, b: string): number {
	const parse = (s: string) => s.split('-')[0]!.split('.').map((n) => Number(n) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) { return da - db; }
	}
	return 0;
}
