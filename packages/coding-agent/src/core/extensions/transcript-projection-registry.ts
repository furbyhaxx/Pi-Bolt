/**
 * The session's one transcript projection provider, registered with `pi.registerTranscriptProjection()`.
 *
 * The core only stores the registration and rejects a second owner. The transcript itself is rendered by the
 * host (docs/extensions.md#piregistertranscriptprojectionprovider).
 */

import type {
	TranscriptProjectionChange,
	TranscriptProjectionHandle,
	TranscriptProjectionProvider,
} from "../transcript-projection.ts";

/** A provider and the extension that registered it. */
export interface TranscriptProjectionRegistration {
	readonly provider: TranscriptProjectionProvider;
	readonly extensionPath: string;
}

export class TranscriptProjectionRegistry {
	private registration: TranscriptProjectionRegistration | undefined;
	private changeListener: ((change: TranscriptProjectionChange) => void) | undefined;
	/** Refreshes asked for before a runner bound: the provider is not registered yet, so nobody could hear them. */
	private readonly pendingRefreshes = new WeakSet<TranscriptProjectionProvider>();
	private generation = 0;

	/** Register a provider, or return why a different extension holds the slot. The owner may replace its own. */
	register(registration: TranscriptProjectionRegistration): string | undefined {
		const owner = this.registration?.extensionPath;
		if (owner !== undefined && owner !== registration.extensionPath) {
			return `Transcript projection provider "${registration.provider.id}" from ${registration.extensionPath} is ignored: ${owner} already registered the session's transcript projection provider, and a session renders one`;
		}
		this.registration = registration;
		this.changeListener?.({ kind: "provider" });
		if (this.pendingRefreshes.delete(registration.provider)) this.changeListener?.({ kind: "invalidate" });
		return undefined;
	}

	get(): TranscriptProjectionProvider | undefined {
		return this.registration?.provider;
	}

	/** A handle whose `invalidate()` asks the host to re-request this provider's projection for the current branch. */
	handle(provider: TranscriptProjectionProvider): TranscriptProjectionHandle {
		const generation = this.generation;
		return {
			invalidate: () => {
				if (generation === this.generation) this.invalidate(provider);
			},
		};
	}

	/** Drop the provider of a runtime that went stale, after its session was replaced or its extensions reloaded. */
	clear(): void {
		if (this.registration === undefined) return;
		this.registration = undefined;
		// Handles made for the dropped registration stay dead, even when a reload registers the same provider object.
		this.generation++;
		this.changeListener?.({ kind: "provider" });
	}

	/** Called after every change. The runner sets it when it binds, to notify its subscribers. */
	setChangeListener(listener: ((change: TranscriptProjectionChange) => void) | undefined): void {
		this.changeListener = listener;
	}

	private invalidate(provider: TranscriptProjectionProvider): void {
		if (this.registration?.provider === provider) {
			this.changeListener?.({ kind: "invalidate" });
			return;
		}
		if (this.registration === undefined) this.pendingRefreshes.add(provider);
	}
}
