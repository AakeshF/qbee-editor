/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QBee inline FIM completion provider — registers with the languageFeaturesService
// and proxies to the worker's /api/complete endpoint.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletions,
	InlineCompletionsProvider,
	InlineCompletionsDisposeReason,
} from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { registerEditorFeature } from '../../../../editor/common/editorFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// Phase 3 dev: worker URL is the standalone tsx-watch port. Production replaces this
// with the editor-served loopback URL once spaProxyService lands.
const DEV_WORKER_URL = 'http://127.0.0.1:8421';
const DEV_WORKER_AUTH = 'dev';

const CONFIG_PREFIX = 'qbee.inlineCompletions';
const CONFIG_ENABLED = `${CONFIG_PREFIX}.enabled`;
const CONFIG_PROVIDER_ID = `${CONFIG_PREFIX}.providerId`;
const CONFIG_MODEL = `${CONFIG_PREFIX}.model`;
const CONFIG_BASE_URL = `${CONFIG_PREFIX}.baseUrl`;
const CONFIG_MAX_TOKENS = `${CONFIG_PREFIX}.maxTokens`;
const CONFIG_LANGUAGES = `${CONFIG_PREFIX}.languages`;

const DEFAULT_LANGUAGES = [
	'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
	'python', 'go', 'rust', 'java', 'cpp', 'c', 'csharp', 'ruby', 'php', 'swift', 'kotlin',
	'shellscript', 'sql', 'html', 'css', 'json', 'yaml',
];

interface QBeeInlineCompletions extends InlineCompletions {
	items: InlineCompletion[];
}

class QBeeInlineCompletionProvider extends Disposable implements InlineCompletionsProvider<QBeeInlineCompletions> {
	readonly displayName = 'QBee';
	readonly groupId = 'qbee';
	readonly debounceDelayMs = 150;

	// Tiny LRU keyed on (last 256 chars of prefix, first 64 chars of suffix, language).
	// Keeps re-typing the same context cheap.
	private readonly cache = new Map<string, string>();
	private readonly cacheCap = 256;

	constructor(
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(languageFeatures.inlineCompletionsProvider.register('*', this));
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<QBeeInlineCompletions | undefined> {
		if (!this.configurationService.getValue<boolean>(CONFIG_ENABLED)) {
			return undefined;
		}

		const allowedLanguages = this.configurationService.getValue<string[]>(CONFIG_LANGUAGES) ?? DEFAULT_LANGUAGES;
		if (!allowedLanguages.includes(model.getLanguageId())) {
			return undefined;
		}

		const prefix = model.getValueInRange(new Range(1, 1, position.lineNumber, position.column));
		const lastLine = model.getLineCount();
		const suffix = model.getValueInRange(new Range(position.lineNumber, position.column, lastLine, model.getLineMaxColumn(lastLine)));

		const cacheKey = `${model.getLanguageId()}|${prefix.slice(-256)}|${suffix.slice(0, 64)}`;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) {
			this.touchCache(cacheKey, cached);
			return cached ? this.toCompletions(cached, position) : undefined;
		}

		let text: string | undefined;
		try {
			text = await this.fetchCompletion(prefix, suffix, model.getLanguageId(), model.uri.toString(), token);
		} catch (err) {
			console.warn('[QBee] inline completion failed:', (err as Error).message);
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		this.touchCache(cacheKey, text ?? '');
		return text ? this.toCompletions(text, position) : undefined;
	}

	private toCompletions(text: string, position: Position): QBeeInlineCompletions {
		return {
			items: [
				{
					insertText: text,
					range: Range.fromPositions(position, position),
				},
			],
		};
	}

	private touchCache(key: string, value: string): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, value);
		if (this.cache.size > this.cacheCap) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
	}

	private async fetchCompletion(
		prefix: string,
		suffix: string,
		language: string,
		filePath: string,
		token: CancellationToken,
	): Promise<string | undefined> {
		const providerId = this.configurationService.getValue<string>(CONFIG_PROVIDER_ID) || 'openai-compatible';
		const model = this.configurationService.getValue<string>(CONFIG_MODEL) || 'qwen2.5-coder:1.5b';
		const baseUrl = this.configurationService.getValue<string>(CONFIG_BASE_URL) || 'http://127.0.0.1:11434/v1';
		const maxTokens = this.configurationService.getValue<number>(CONFIG_MAX_TOKENS) || 128;

		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());

		try {
			const res = await fetch(`${DEV_WORKER_URL}/api/complete`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Basic ${btoa(`qbee:${DEV_WORKER_AUTH}`)}`,
				},
				body: JSON.stringify({
					provider: { id: providerId, model, baseUrl },
					prefix,
					suffix,
					language,
					filePath,
					maxTokens,
				}),
				signal: ac.signal,
			});
			if (!res.ok) {
				return undefined;
			}
			const json = (await res.json()) as { text?: string };
			return json.text;
		} finally {
			sub.dispose();
		}
	}

	freeInlineCompletions(_completions: QBeeInlineCompletions): void {
		// Nothing to free — completions are plain objects.
	}

	disposeInlineCompletions(_completions: QBeeInlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// Nothing to free — completions are plain objects.
	}
}

// Configuration schema — exposes user-facing settings under "qbee.*".
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'qbee',
	title: localize('qbee.title', 'QBee'),
	type: 'object',
	properties: {
		'qbee.workerUrl': {
			type: 'string',
			default: 'http://localhost:5173',
			description: localize('qbee.workerUrl', 'URL the QBee sidebar loads. Dev default points at Vite (5173) which proxies /api/* to the worker. In the AppImage AppRun overrides this via the QBEE_WORKER_URL env var.'),
		},
		'qbee.workerAuth': {
			type: 'string',
			default: 'dev',
			description: localize('qbee.workerAuth', 'Basic-auth password the SPA uses to call /api/* on the worker. Must match QBEE_WORKER_AUTH on the worker process.'),
		},
		[CONFIG_ENABLED]: {
			type: 'boolean',
			default: true,
			description: localize('qbee.inlineCompletions.enabled', 'Enable QBee inline (FIM) completions.'),
		},
		[CONFIG_PROVIDER_ID]: {
			type: 'string',
			enum: ['openai-compatible', 'anthropic', 'gemini', 'local-llama'],
			default: 'openai-compatible',
			description: localize('qbee.inlineCompletions.providerId', 'Provider to use for inline completions. Anthropic and Gemini do not support FIM today; openai-compatible covers Ollama, LM Studio, llama.cpp, vLLM.'),
		},
		[CONFIG_MODEL]: {
			type: 'string',
			default: 'qwen2.5-coder:1.5b',
			description: localize('qbee.inlineCompletions.model', 'Model name for inline completions. Qwen, DeepSeek, Codestral, and StarCoder FIM templates are auto-detected from the model name.'),
		},
		[CONFIG_BASE_URL]: {
			type: 'string',
			default: 'http://127.0.0.1:11434/v1',
			description: localize('qbee.inlineCompletions.baseUrl', 'OpenAI-compatible endpoint URL. Defaults to Ollama on localhost.'),
		},
		[CONFIG_MAX_TOKENS]: {
			type: 'number',
			default: 128,
			minimum: 16,
			maximum: 1024,
			description: localize('qbee.inlineCompletions.maxTokens', 'Maximum tokens per completion.'),
		},
		[CONFIG_LANGUAGES]: {
			type: 'array',
			items: { type: 'string' },
			default: DEFAULT_LANGUAGES,
			description: localize('qbee.inlineCompletions.languages', 'Language IDs that get inline completions.'),
		},
	},
});

registerEditorFeature(QBeeInlineCompletionProvider);
