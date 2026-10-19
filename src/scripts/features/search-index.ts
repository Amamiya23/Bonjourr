import type { Sync } from '../../types/sync.ts'

export interface SearchResult {
    text: string
    desc?: string
    image?: string
    url?: string
}

export function searchLinks(data: Sync, query: string): SearchResult[] {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const results: SearchResult[] = []
    for (const value of Object.values(data)) {
        if (!value || typeof value !== 'object' || !('url' in value) || !('title' in value)) continue
        const link = value as { title: string; url: string; parent?: string }
        if (typeof link.title !== 'string' || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url)) continue
        const parents: string[] = []
        let parent = link.parent
        const seen = new Set<string>()
        while (parent && !seen.has(parent)) {
            seen.add(parent)
            const folder = data[parent] as { title?: string; parent?: string } | undefined
            parents.unshift(folder?.title ?? (parent === 'default' ? '常用' : parent))
            parent = folder?.parent
        }
        const text = `${link.title} ${link.url} ${parents.join(' ')}`.toLocaleLowerCase()
        if (words.every((word) => text.includes(word))) {
            results.push({ text: link.title, desc: `应用 · ${parents.join(' / ')}`, url: link.url })
        }
    }
    return results.sort((a, b) =>
        Number(b.text.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) -
        Number(a.text.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()))
    ).slice(0, 6)
}
