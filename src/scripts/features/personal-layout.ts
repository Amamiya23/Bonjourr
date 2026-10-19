import { storage } from '../storage.ts'
import { onSettingsLoad } from '../utils/onsettingsload.ts'
import type { Sync } from '../../types/sync.ts'

export function personalLayout(sync: Sync): void {
    const apply = (enabled: boolean) => document.getElementById('interface')?.classList.toggle('compact', enabled)
    apply(sync.compactLayout !== false)
    onSettingsLoad(() => {
        const range = document.getElementById('i_pagegap')?.closest('.wrapper')
        if (!range) return
        const wrapper = document.createElement('div')
        wrapper.className = 'wrapper'
        const label = document.createElement('label')
        label.htmlFor = 'compact-layout'
        label.textContent = '紧凑布局'
        label.title = '缩减组件间距，保留上方留白'
        const input = document.createElement('input')
        input.id = 'compact-layout'
        input.type = 'checkbox'
        input.className = 'switch'
        input.checked = sync.compactLayout !== false
        input.addEventListener('change', () => {
            apply(input.checked)
            void storage.sync.set({ compactLayout: input.checked })
        })
        wrapper.append(label, input)
        range.before(wrapper, document.createElement('hr'))
    })
}
