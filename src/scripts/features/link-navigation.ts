import { storage } from '../storage.ts'

/** Share the opening preference between web search, search results and app icons. */
export async function setOpenInNewTab(enabled: boolean): Promise<void> {
    const data = await storage.sync.get()
    await storage.sync.set({
        linknewtab: enabled,
        searchbar: { ...data.searchbar, newtab: enabled },
    })

    document.getElementById('sb_container')?.setAttribute('data-newtab', String(enabled))
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('#linkblocks .link a')) {
        if (enabled) {
            anchor.target = '_blank'
        } else {
            anchor.removeAttribute('target')
        }
    }
}
