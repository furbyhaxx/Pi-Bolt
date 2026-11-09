/**
 * The session's one transcript projection provider, registered with `pi.registerTranscriptProjection()`.
 *
 * The core only stores the registration and rejects a second owner. The transcript itself is rendered by the
 * host (docs/extensions.md#piregistertranscriptprojectionprovider).
 */

import type { TranscriptProjectionProvider } from "../transcript-projection.ts";

/** A provider and the extension that registered it. */
export interface TranscriptProjectionRegistration {
	readonly provider: TranscriptProjectionProvider;
	readonly extensionPath: string;
}

export class TranscriptProjectionRegistry {
	private registration: TranscriptProjectionRegistration | undefined;
	private changeListener: (() => void) | undefined;

	/** Register a provider, or return why a different extension holds the slot. The owner may replace its own. */
	register(registration: TranscriptProjectionRegistration): string | undefined {
		const owner = this.registration?.extensionPath;
		if (owner !== undefined && owner !== registration.extensionPath) {
			return `Transcript projection provider "${registration.provider.id}" from ${registration.extensionPath} is ignored: ${owner} already registered the session's transcript projection provider, and a session renders one`;
		}
		this.registration = registration;
		this.changeListener?.();
		return undefined;
	}

	get(): TranscriptProjectionProvider | undefined {
		return this.registration?.provider;
	}

	/** Drop the provider of a runtime that went stale, after its session was replaced or its extensions reloaded. */
	clear(): void {
		if (this.registration === undefined) return;
		this.registration = undefined;
		this.changeListener?.();
	}

	/** Called after every change. The runner sets it when it binds, to notify its subscribers. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
