import { storage } from '../../storage.ts'
import { cloudFetch, cloudJson } from './cloud-api.ts'

interface CloudDevice {
    id: string
    name: string
    created_at?: string
    revoked_at?: string
}

export function cloudDevices(run: (action: () => Promise<void>) => Promise<void>): void {
    const section = document.querySelector<HTMLDetailsElement>('#cloud-devices-section')!
    const container = document.getElementById('cloud-devices')!
    const status = document.getElementById('cloud-devices-status')!
    const template = document.querySelector<HTMLTemplateElement>('#cloud-device-template')!
    let loaded = false

    const load = async (): Promise<void> => {
        const current = (await storage.local.get('cloud')).cloud
        if (!current?.accountId) return
        status.textContent = '正在获取设备…'
        status.dataset.state = 'pending'
        container.setAttribute('aria-busy', 'true')
        try {
            const devices = await cloudJson<CloudDevice[]>(current, 'devices')
            container.replaceChildren()
            for (const device of devices.filter((item) => !item.revoked_at)) {
                const row = template.content.firstElementChild!.cloneNode(true) as HTMLElement
                const title = row.querySelector<HTMLElement>('.cloud-device-name')!
                const badge = row.querySelector<HTMLElement>('.cloud-device-current')!
                const meta = row.querySelector<HTMLElement>('.cloud-device-meta')!
                const actions = row.querySelector<HTMLElement>('.cloud-device-actions')!
                const rename = row.querySelector<HTMLButtonElement>('[data-action="rename"]')!
                const revoke = row.querySelector<HTMLButtonElement>('[data-action="revoke"]')!
                const cancel = row.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
                const form = row.querySelector<HTMLFormElement>('form')!
                const input = form.querySelector<HTMLInputElement>('input')!
                const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!
                const message = row.querySelector<HTMLElement>('.cloud-device-status')!
                const own = device.id === current.deviceId
                row.dataset.deviceId = device.id
                form.id = `cloud-device-editor-${device.id}`
                rename.setAttribute('aria-controls', form.id)
                rename.setAttribute('aria-expanded', 'false')
                title.textContent = device.name
                badge.hidden = !own
                revoke.hidden = own
                input.value = device.name
                input.setAttribute('aria-label', `设备名称：${device.name}`)
                meta.textContent = device.created_at
                    ? `${new Date(device.created_at).toLocaleDateString()} 登录`
                    : '已登录设备'

                const closeEditor = (): void => {
                    form.hidden = true
                    rename.setAttribute('aria-expanded', 'false')
                    actions.hidden = false
                    input.value = device.name
                    input.setCustomValidity('')
                    rename.focus()
                }
                rename.addEventListener('click', () => {
                    form.hidden = false
                    rename.setAttribute('aria-expanded', 'true')
                    actions.hidden = true
                    message.textContent = ''
                    input.focus()
                    input.select()
                })
                cancel.addEventListener('click', closeEditor)
                input.addEventListener('input', () => input.setCustomValidity(''))
                input.addEventListener('keydown', (event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    event.stopPropagation()
                    closeEditor()
                })
                input.addEventListener('keyup', (event) => {
                    if (event.key === 'Escape') event.stopPropagation()
                })
                form.addEventListener('submit', (event) => {
                    event.preventDefault()
                    const name = input.value.trim()
                    if (!name || name.length > 80) {
                        input.setCustomValidity('设备名称需为 1–80 个字符。')
                        input.reportValidity()
                        return
                    }
                    void run(async () => {
                        save.textContent = '保存中…'
                        input.disabled = true
                        form.setAttribute('aria-busy', 'true')
                        message.textContent = ''
                        try {
                            const result = await cloudJson<{ id: string; name: string }>(
                                current,
                                `devices/${encodeURIComponent(device.id)}`,
                                { name },
                                'PUT',
                            )
                            const latest = (await storage.local.get('cloud')).cloud
                            if (own && latest?.token === current.token && latest.url === current.url) {
                                await storage.local.set({ cloud: { ...latest, name: result.name } })
                                const loginName = document.querySelector<HTMLInputElement>('#cloud-device-name')
                                if (loginName) loginName.value = result.name
                            }
                            device.name = result.name
                            title.textContent = result.name
                            input.setAttribute('aria-label', `设备名称：${result.name}`)
                            closeEditor()
                            message.dataset.state = 'success'
                            message.textContent = '设备名称已更新'
                        } catch (error) {
                            message.dataset.state = 'error'
                            message.textContent = error instanceof Error ? error.message : '保存失败，请重试。'
                        } finally {
                            save.textContent = '保存'
                            input.disabled = false
                            form.setAttribute('aria-busy', 'false')
                        }
                    }).then(() => {
                        if (form.hidden && rename.isConnected) rename.focus()
                    })
                })
                revoke.addEventListener('click', () => {
                    if (!confirm(`撤销“${device.name}”的访问权限？该设备需要重新登录。`)) return
                    void run(async () => {
                        await cloudFetch(current, `devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })
                        row.remove()
                    })
                })
                container.append(row)
            }
            loaded = true
            status.textContent = container.childElementCount ? '' : '暂无已登录设备'
        } catch (error) {
            status.dataset.state = 'error'
            status.textContent = error instanceof Error ? error.message : '无法获取设备，请重试。'
        } finally {
            container.setAttribute('aria-busy', 'false')
        }
    }
    section.addEventListener('toggle', () => {
        if (section.open && !loaded) void run(load)
    })
    document.getElementById('cloud-devices-refresh')!.addEventListener('click', () => void run(load))
}
