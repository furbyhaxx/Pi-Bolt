/** Retained values identified by stable, caller-owned keys for one session. */
export interface SessionLifetime {
	/** Return the retained value or create it; each key must use one value type and a runtime-independent disposer. */
	retain<T>(key: string, create: () => T, dispose: (value: T) => void | Promise<void>): T;
}

type RetainedCell = {
	value: unknown;
	dispose: () => void | Promise<void>;
};

class CellFinalizationError extends Error {
	readonly key: string;

	constructor(key: string, cause: unknown) {
		super(`Failed to finalize retained cell ${JSON.stringify(key)}`, { cause });
		this.name = "CellFinalizationError";
		this.key = key;
	}
}

/** Host-owned retained-cell registry for a single session. */
export class SessionLifetimeStore implements SessionLifetime {
	private readonly cells = new Map<string, RetainedCell>();
	private readonly creating = new Set<string>();
	private closed = false;
	private finalizing: Promise<void> | undefined;

	/** Return a retained value, rejecting access after finalization has started. */
	retain<T>(key: string, create: () => T, dispose: (value: T) => void | Promise<void>): T {
		if (this.closed) throw new Error("Session lifetime is closed");
		const cell = this.cells.get(key);
		if (cell) return cell.value as T;
		if (this.creating.has(key)) throw new Error(`Recursive creation of retained cell ${JSON.stringify(key)}`);

		this.creating.add(key);
		try {
			const value = create();
			this.cells.set(key, { value, dispose: () => dispose(value) });
			return value;
		} finally {
			this.creating.delete(key);
		}
	}

	/**
	 * Close the registry and finalize cells concurrently, retrying failures on later calls.
	 * @throws AggregateError with key and cause for each failed finalizer.
	 */
	finalize(): Promise<void> {
		if (this.finalizing) return this.finalizing;
		this.closed = true;
		if (this.cells.size === 0 && this.creating.size === 0) return Promise.resolve();

		const pass = Promise.resolve().then(async () => {
			const results = await Promise.all(
				Array.from(this.cells, async ([key, cell]) => {
					try {
						await cell.dispose();
						this.cells.delete(key);
					} catch (cause) {
						return new CellFinalizationError(key, cause);
					}
				}),
			);
			const failures = results.filter((result) => result !== undefined);
			if (failures.length > 0) throw new AggregateError(failures, "Failed to finalize retained cells");
		});
		this.finalizing = pass.then(
			() => {
				this.finalizing = undefined;
			},
			(error: unknown) => {
				this.finalizing = undefined;
				throw error;
			},
		);
		return this.finalizing;
	}
}
