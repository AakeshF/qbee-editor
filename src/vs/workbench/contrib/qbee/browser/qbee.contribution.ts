/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QBee fork — fork-only contribution. All AI features hang off this entry point.
// Phase 3: inline FIM completions register themselves on import.
import './inlineCompletionProvider.js';
// Phase 6/v0.2.0: in-app updater (Check for Updates command + background check).
import { QBeeUpdateCheckOnStartup } from './updater.js';

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewContainer, IViewContainersRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, IViewsRegistry, IViewDescriptor, IViewDescriptorService } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { IBulkEditService } from '../../../../editor/browser/services/bulkEditService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditApplier, type ApplyEditRequest } from './editApplier.js';

const QBEE_VIEW_CONTAINER_ID = 'workbench.view.qbee';
const QBEE_CHAT_VIEW_ID = 'workbench.view.qbee.chat';

// Phase 7: webview URL is configurable. Defaults differ:
//   - dev (tmux-dev.sh): Vite serves the SPA at 5173 and proxies /api/* to the worker on 8421
//   - production AppImage: AppRun starts the bundled worker which serves both SPA + /api/*
// The user can override via the qbee.workerUrl setting. We always append #auth=<token>.
const QBEE_DEFAULT_WORKER_URL = 'http://localhost:5173';
const QBEE_DEFAULT_AUTH = 'dev';
const QBEE_CONFIG_WORKER_URL = 'qbee.workerUrl';
const QBEE_CONFIG_WORKER_AUTH = 'qbee.workerAuth';

const qbeeViewIcon = registerIcon('qbee-view-icon', Codicon.sparkle, localize('qbeeViewIcon', 'View icon of the QBee AI panel.'));

class QBeeChatView extends ViewPane {
	static readonly ID = QBEE_CHAT_VIEW_ID;
	static readonly NAME: ILocalizedString = localize2('qbeeChat', 'QBee Chat');

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.height = '100%';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		// Resolve the webview target from settings. QBEE_WORKER_URL env var (set by AppRun)
		// wins over user settings so the AppImage works out of the box.
		const envWorkerUrl = (typeof process !== 'undefined' && process.env?.QBEE_WORKER_URL) || undefined;
		const envAuth = (typeof process !== 'undefined' && process.env?.QBEE_WORKER_AUTH) || undefined;
		const settingWorkerUrl = this.configurationService.getValue<string>(QBEE_CONFIG_WORKER_URL);
		const settingAuth = this.configurationService.getValue<string>(QBEE_CONFIG_WORKER_AUTH);
		const workerUrl = (envWorkerUrl || settingWorkerUrl || QBEE_DEFAULT_WORKER_URL).replace(/\/$/, '');
		const auth = envAuth || settingAuth || QBEE_DEFAULT_AUTH;
		const spaUrl = `${workerUrl}/#auth=${encodeURIComponent(auth)}`;
		const workerPort = this.parsePort(workerUrl);

		const webview = this.webviewService.createWebviewElement({
			title: 'QBee',
			options: { purpose: WebviewContentPurpose.WebviewView, retainContextWhenHidden: true },
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				...(workerPort ? { portMapping: [{ webviewPort: workerPort, extensionHostPort: workerPort }] } : {}),
			},
			extension: undefined,
		});
		this._register(webview);

		// The relay script is what makes Phase 4.5 apply work. Three layers of frames:
		//   editor → webview iframe (vscode-webview://) → SPA iframe (http://localhost:<workerPort>)
		// SPA's window.parent.postMessage reaches the webview HTML; the relay forwards to
		// the editor via acquireVsCodeApi, and forwards the editor's reply back to the SPA.
		webview.setHtml(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:* http://127.0.0.1:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>html,body{margin:0;padding:0;height:100%;background:#1e1e1e;}iframe{width:100%;height:100%;border:0;display:block;}</style>
</head>
<body>
<iframe id="spa" src="${spaUrl}"></iframe>
<script>
(function () {
	const vscode = acquireVsCodeApi();
	const iframe = document.getElementById('spa');
	window.addEventListener('message', function (e) {
		if (e.source === iframe.contentWindow) {
			// SPA → editor
			vscode.postMessage(e.data);
		} else if (e.data && typeof e.data === 'object') {
			// editor → SPA
			if (iframe.contentWindow) { iframe.contentWindow.postMessage(e.data, '*'); }
		}
	});
})();
</script>
</body>
</html>`);

		const editApplier = new EditApplier(this.bulkEditService, this.fileService, this.contextService);

		this._register(webview.onMessage(async (e) => {
			const msg = e.message as { type?: string };
			if (!msg || msg.type !== 'apply_edit') {
				return;
			}
			const response = await editApplier.apply(msg as ApplyEditRequest);
			webview.postMessage(response);
		}));

		webview.mountTo(container, getWindow(container));
	}

	private parsePort(url: string): number | undefined {
		try {
			const parsed = new URL(url);
			const port = Number(parsed.port);
			return Number.isFinite(port) && port > 0 ? port : undefined;
		} catch {
			return undefined;
		}
	}
}

const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: QBEE_VIEW_CONTAINER_ID,
	title: localize2('qbee', 'QBee'),
	icon: qbeeViewIcon,
	order: 5,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [QBEE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: QBEE_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: false });

const chatView: IViewDescriptor = {
	id: QBEE_CHAT_VIEW_ID,
	name: QBeeChatView.NAME,
	containerIcon: qbeeViewIcon,
	ctorDescriptor: new SyncDescriptor(QBeeChatView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([chatView], viewContainer);

// Background update-check: runs once at workbench restore.
registerWorkbenchContribution2(QBeeUpdateCheckOnStartup.ID, QBeeUpdateCheckOnStartup, WorkbenchPhase.Eventually);
