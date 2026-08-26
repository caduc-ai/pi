import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * After the first turn (>=1 user + >=1 assistant message), an unnamed session
 * should get a short model-generated title via a background, non-blocking
 * completion, using the same path as AgentSession.setSessionName.
 */

function respondWith(harness: Harness, textForCall: (call: number) => string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		const text = textForCall(callCount);
		queueMicrotask(() => {
			const message = {
				...fauxAssistantMessage(text),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

describe("AgentSession auto session naming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("generates a title from the model after the first turn when unnamed", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		const callCount = respondWith(harness, (call) => (call === 1 ? "Sure, here is how to fix it." : "Fix Login Bug"));

		await harness.session.prompt("How do I fix the login bug?");

		await vi.waitFor(() => {
			expect(harness.sessionManager.getSessionName()).toBe("Fix Login Bug");
		});

		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["Fix Login Bug"]);
		expect(callCount()).toBe(2);
	});

	it("does not run when the session already has a name", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);
		harness.session.setSessionName("Existing Name");

		const callCount = respondWith(harness, () => "reply");

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getSessionName()).toBe("Existing Name");
		expect(callCount()).toBe(1);
	});

	it("does not re-trigger on later turns once attempted", async () => {
		const harness = await createHarness({ settings: { autoNameSession: true } });
		harnesses.push(harness);

		const callCount = respondWith(harness, (call) => (call <= 2 ? `reply ${call}` : `title-ish ${call}`));

		await harness.session.prompt("first message");
		await vi.waitFor(() => expect(callCount()).toBe(2));

		await harness.session.prompt("second message");
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Only the first turn's reply (1) plus the one title generation (2) plus the
		// second turn's reply (3): no second title-generation call.
		expect(callCount()).toBe(3);
	});

	it("is skippable via the autoNameSession setting", async () => {
		const harness = await createHarness({ settings: { autoNameSession: false } });
		harnesses.push(harness);

		const callCount = respondWith(harness, () => "reply");

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(callCount()).toBe(1);
	});
});
