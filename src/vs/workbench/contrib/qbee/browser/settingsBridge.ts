/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

// Allow the SPA to read and write VSCode settings through the existing webview
// postMessage relay. Today this is what makes the dashboard's FIM section
// editable — qbee.inlineCompletions.* lives in IConfigurationService, not in
// localStorage, because the editor-side InlineCompletionProvider is the only
// thing that consumes it.
//
// Whitelisted to qbee.* prefix so the SPA can't reach into unrelated VSCode
// settings even though the SPA is in our process and we trust it. Defense in
// depth.

const SETTINGS_PREFIX = 'qbee.';

interface IncomingMessage {
	type?: string;
}

interface GetSettingMessage extends IncomingMessage {
	type: 'get_setting';
	requestId: string;
	key: string;
}

interface SetSettingMessage extends IncomingMessage {
	type: 'set_setting';
	requestId: string;
	key: string;
	value: unknown;
}

type OutgoingMessage =
	| { type: 'setting_value'; requestId: string; key: string; value: unknown }
	| { type: 'set_setting_ack'; requestId: string; key: string; ok: boolean; error?: string }
	| { type: 'setting_changed'; key: string; value: unknown };

export class SettingsBridge extends Disposable {

	constructor(
		private readonly send: (message: OutgoingMessage) => void,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration((e) => {
			// Push every qbee.* change so the SPA can mirror without polling.
			for (const key of e.affectedKeys) {
				if (key.startsWith(SETTINGS_PREFIX)) {
					this.send({ type: 'setting_changed', key, value: configurationService.getValue(key) });
				}
			}
		}));
	}

	async handle(msg: unknown): Promise<boolean> {
		if (!msg || typeof msg !== 'object') {
			return false;
		}
		const m = msg as IncomingMessage;
		if (m.type === 'get_setting') {
			const req = m as GetSettingMessage;
			if (!isAllowedKey(req.key)) {
				this.send({ type: 'setting_value', requestId: req.requestId, key: req.key, value: undefined });
				return true;
			}
			const value = this.configurationService.getValue(req.key);
			this.send({ type: 'setting_value', requestId: req.requestId, key: req.key, value });
			return true;
		}
		if (m.type === 'set_setting') {
			const req = m as SetSettingMessage;
			if (!isAllowedKey(req.key)) {
				this.send({ type: 'set_setting_ack', requestId: req.requestId, key: req.key, ok: false, error: 'key not allowed' });
				return true;
			}
			try {
				await this.configurationService.updateValue(req.key, req.value, ConfigurationTarget.USER);
				this.send({ type: 'set_setting_ack', requestId: req.requestId, key: req.key, ok: true });
			} catch (err) {
				this.send({ type: 'set_setting_ack', requestId: req.requestId, key: req.key, ok: false, error: (err as Error).message });
			}
			return true;
		}
		return false;
	}
}

function isAllowedKey(key: string): boolean {
	return typeof key === 'string' && key.startsWith(SETTINGS_PREFIX);
}
