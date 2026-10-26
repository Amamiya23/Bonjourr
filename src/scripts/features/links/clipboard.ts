import { getLink } from './helpers.ts'
import { storage } from '../../storage.ts'

import type { LinkElem } from '../../../types/shared.ts'

interface LinkClipboard {
    link: LinkElem
    icon?: string
}

let clipboard: LinkClipboard | undefined

export async function copyLink(id: string): Promise<boolean> {
    const data = await storage.sync.get()
    const link = getLink(data, id)
    if (!link || link.folder) return false

    const copy: LinkClipboard = { link: structuredClone(link) }
    if (link.icon?.type === 'file') {
        const key = `x-icon-${id}` as const
        copy.icon = (await storage.local.get(key))[key]
    }
    clipboard = copy
    return true
}

export function hasCopiedLink(): boolean {
    return clipboard !== undefined
}

export function getCopiedLink(): LinkClipboard | undefined {
    return clipboard ? structuredClone(clipboard) : undefined
}
