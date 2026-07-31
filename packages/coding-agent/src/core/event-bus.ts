import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	/** Subscribe to one channel. The handler receives the emitted data. */
	on(channel: string, handler: (data: unknown) => void): () => void;
	/** Subscribe to every channel. The handler receives (channel, data). */
	on(channel: "*", handler: (channel: string, data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
			emitter.emit("*", channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (channelOrData: unknown, data?: unknown) => {
				try {
					if (channel === "*") {
						await (handler as (channel: string, data: unknown) => void)(channelOrData as string, data);
					} else {
						await (handler as (data: unknown) => void)(channelOrData);
					}
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
