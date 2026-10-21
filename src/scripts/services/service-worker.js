if (globalThis.chrome?.storage) {
    chrome.action.onClicked.addListener(createNewTab)
    chrome.runtime.onInstalled.addListener(handleInstalled)
    chrome.runtime.setUninstallURL('https://bonjourr.fr/goodbye')
} else {
    self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
    self.addEventListener('activate', (event) => event.waitUntil(updateCache()))
    self.addEventListener('fetch', retrieveCache)
}

const CACHE_KEY = 'bonjourr-shell-cloud-v1'

// Web Extension

function createNewTab() {
    const url = chrome.runtime.getURL('index.html')
    chrome.tabs.create({ url })
}

function handleInstalled(details) {
    if (details.reason === 'install') {
        createNewTab()
    }
}

// Progressive Web App

async function updateCache() {
    const keys = await caches.keys()

    for (const key of keys) {
        if (key !== CACHE_KEY && (key.startsWith('bonjourr-shell-') || /^\d+\.\d+\.\d+$/.test(key))) {
            await caches.delete(key)
        }
    }
    await self.clients.claim()
}

function retrieveCache(event) {
    const request = event.request
    const url = new URL(request.url)
    if (
        request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') ||
        request.headers.has('Authorization')
    ) return

    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE_KEY)
            try {
                const response = await fetch(request)
                if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
                return response
            } catch (error) {
                const cached = await cache.match(request)
                if (cached) return cached
                throw error
            }
        })(),
    )
}
