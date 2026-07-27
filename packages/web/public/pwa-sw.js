const CACHE_VERSION = "pi-web-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

function scopeUrl(path) {
	return new URL(path, self.registration.scope).href;
}

async function cacheCoreAssets() {
	const cache = await caches.open(STATIC_CACHE);
	await cache.addAll([
		scopeUrl("."),
		scopeUrl("manifest.webmanifest"),
		scopeUrl("icons/pi.svg"),
		scopeUrl("icons/pi-180.png"),
		scopeUrl("icons/pi-192.png"),
		scopeUrl("icons/pi-512.png"),
	]);
}

self.addEventListener("install", (event) => {
	event.waitUntil(cacheCoreAssets().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name.startsWith("pi-web-") && name !== STATIC_CACHE && name !== RUNTIME_CACHE)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

function shouldHandle(request) {
	if (request.method !== "GET") return false;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;
	if (url.pathname.endsWith("/ws")) return false;
	if (url.pathname.startsWith("/api/")) return false;
	return true;
}

async function networkFirst(request) {
	const cache = await caches.open(RUNTIME_CACHE);
	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached) return cached;
		const shell = await caches.match(scopeUrl("."));
		if (shell) return shell;
		throw error;
	}
}

async function cacheFirst(request) {
	const cached = await caches.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) {
		const cache = await caches.open(RUNTIME_CACHE);
		await cache.put(request, response.clone());
	}
	return response;
}

function isStaticAsset(url) {
	return (
		url.pathname.includes("/assets/") ||
		url.pathname.includes("/icons/") ||
		url.pathname.endsWith("/manifest.webmanifest") ||
		url.pathname.endsWith(".js") ||
		url.pathname.endsWith(".css") ||
		url.pathname.endsWith(".png") ||
		url.pathname.endsWith(".svg")
	);
}

self.addEventListener("fetch", (event) => {
	if (!shouldHandle(event.request)) return;
	const url = new URL(event.request.url);
	if (event.request.mode === "navigate") {
		event.respondWith(networkFirst(event.request));
	} else if (isStaticAsset(url)) {
		event.respondWith(cacheFirst(event.request));
	}
});
