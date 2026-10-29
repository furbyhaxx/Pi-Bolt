import { describe, expect, test, vi } from "vitest";
import { type SessionLifetime, SessionLifetimeStore } from "../src/core/session-lifetime.ts";

describe("SessionLifetimeStore", () => {
	test("retains identity across rebinds and uses a new registry for a replacement session", async () => {
		const store = new SessionLifetimeStore();
		const create = vi.fn(() => ({ count: 0 }));
		const dispose = vi.fn();
		const replacementCreate = vi.fn(() => ({ count: 1 }));
		const replacementDispose = vi.fn();
		const bind = (lifetime: SessionLifetime, factory: typeof create, finalizer: typeof dispose) =>
			lifetime.retain("pi-workbench/services", factory, finalizer);

		const first = bind(store, create, dispose);
		first.count++;
		const rebound = bind(store, replacementCreate, replacementDispose);
		expect(rebound).toBe(first);
		expect(rebound.count).toBe(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(replacementCreate).not.toHaveBeenCalled();

		await store.finalize();
		expect(dispose).toHaveBeenCalledExactlyOnceWith(first);
		expect(replacementDispose).not.toHaveBeenCalled();

		const replacement = new SessionLifetimeStore();
		expect(bind(replacement, replacementCreate, replacementDispose)).not.toBe(first);
		await replacement.finalize();
		expect(replacementCreate).toHaveBeenCalledTimes(1);
		expect(replacementDispose).toHaveBeenCalledTimes(1);
	});

	test("retries a failed factory and retains an undefined value", async () => {
		const store = new SessionLifetimeStore();
		const cause = new Error("factory failed");
		const create = vi.fn<() => undefined>().mockImplementationOnce(() => {
			throw cause;
		});
		const dispose = vi.fn();

		expect(() => store.retain("empty", create, dispose)).toThrow(cause);
		expect(store.retain("empty", create, dispose)).toBeUndefined();
		expect(store.retain("empty", create, dispose)).toBeUndefined();
		expect(create).toHaveBeenCalledTimes(2);
		await store.finalize();
		expect(dispose).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	test("aggregates both cleanup failures, attempts remaining cleanup, and retries only failures", async () => {
		const store = new SessionLifetimeStore();
		const firstCause = new Error("first cleanup failed");
		const secondCause = new Error("second cleanup failed");
		const firstDispose = vi.fn().mockImplementationOnce(() => {
			throw firstCause;
		});
		const secondDispose = vi.fn().mockImplementationOnce(async () => {
			throw secondCause;
		});
		const thirdDispose = vi.fn();
		const firstValue = {};
		const secondValue = {};
		const thirdValue = {};
		store.retain("first", () => firstValue, firstDispose);
		store.retain("second", () => secondValue, secondDispose);
		store.retain("third", () => thirdValue, thirdDispose);

		const finalization = store.finalize();
		const concurrent = store.finalize();
		expect(concurrent).toBe(finalization);
		let failure: unknown;
		try {
			await finalization;
		} catch (error) {
			failure = error;
		}
		await expect(concurrent).rejects.toBe(failure);
		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
		expect(failure.errors).toHaveLength(2);
		expect(failure.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "first", cause: firstCause }),
				expect.objectContaining({ key: "second", cause: secondCause }),
			]),
		);
		expect(firstDispose).toHaveBeenCalledExactlyOnceWith(firstValue);
		expect(secondDispose).toHaveBeenCalledExactlyOnceWith(secondValue);
		expect(thirdDispose).toHaveBeenCalledExactlyOnceWith(thirdValue);
		expect(() => store.retain("first", () => ({}), vi.fn())).toThrow();
		expect(() => store.retain("new", () => ({}), vi.fn())).toThrow();

		await store.finalize();
		expect(firstDispose).toHaveBeenCalledTimes(2);
		expect(secondDispose).toHaveBeenCalledTimes(2);
		expect(thirdDispose).toHaveBeenCalledTimes(1);
		await store.finalize();
		expect(firstDispose).toHaveBeenCalledTimes(2);
		expect(secondDispose).toHaveBeenCalledTimes(2);
	});

	test("closes before callbacks, starts every cleanup, and shares concurrent finalization", async () => {
		const store = new SessionLifetimeStore();
		const gate = Promise.withResolvers<void>();
		let reentrant: Promise<void> | undefined;
		const firstDispose = vi.fn(() => {
			reentrant = store.finalize();
			expect(() => store.retain("first", () => ({}), vi.fn())).toThrow();
			return gate.promise;
		});
		const secondDispose = vi.fn();
		store.retain("first", () => ({}), firstDispose);
		store.retain("second", () => ({}), secondDispose);

		const first = store.finalize();
		const second = store.finalize();
		expect(first).toBe(second);
		expect(() => store.retain("first", () => ({}), vi.fn())).toThrow();
		expect(() => store.retain("new", () => ({}), vi.fn())).toThrow();
		await Promise.resolve();
		expect(reentrant).toBe(first);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);

		gate.resolve();
		await Promise.all([first, second]);
		await store.finalize();
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	test("does not retry a failed cell while another cleanup is still pending", async () => {
		const store = new SessionLifetimeStore();
		const gate = Promise.withResolvers<void>();
		const dispose = vi.fn(() => {
			throw new Error("cleanup failed");
		});
		const pendingDispose = vi.fn(() => gate.promise);
		store.retain("failed", () => ({}), dispose);
		store.retain("pending", () => ({}), pendingDispose);
		const first = store.finalize();

		for (let turn = 0; turn < 5; turn++) {
			await Promise.resolve();
			expect(store.finalize()).toBe(first);
		}
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(pendingDispose).toHaveBeenCalledTimes(1);
		gate.resolve();
		await expect(first).rejects.toBeInstanceOf(AggregateError);
		await expect(store.finalize()).rejects.toBeInstanceOf(AggregateError);
		expect(dispose).toHaveBeenCalledTimes(2);
		expect(pendingDispose).toHaveBeenCalledTimes(1);
	});

	test("rejects recursive creation of the same key without caching a failed factory", async () => {
		const store = new SessionLifetimeStore();
		const innerCreate = vi.fn(() => ({}));
		const dispose = vi.fn();
		expect(() => store.retain("recursive", () => store.retain("recursive", innerCreate, dispose), dispose)).toThrow();
		expect(innerCreate).not.toHaveBeenCalled();
		const value = store.retain("recursive", innerCreate, dispose);
		await store.finalize();
		expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
	});

	test("finalizes a cell whose factory starts finalization before returning", async () => {
		const store = new SessionLifetimeStore();
		const dispose = vi.fn();
		let finalization: Promise<void> | undefined;
		const value = store.retain(
			"during-create",
			() => {
				finalization = store.finalize();
				return {};
			},
			dispose,
		);
		expect(finalization).toBe(store.finalize());
		await finalization;
		expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
	});
});
