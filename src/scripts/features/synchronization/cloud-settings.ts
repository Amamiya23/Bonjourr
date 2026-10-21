import { storage } from '../../storage.ts'
import { keyParts } from '../../shared/cloud.ts'
import type { CloudConnection, CloudState } from '../../shared/cloud.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { cloudFetch, cloudJson } from './cloud-api.ts'
import { connectAccount, defaultAccountServer } from './cloud-account.ts'
import type { AccountConfig } from './cloud-account.ts'
import { adoptCloud, cloudStatus, initializeCloud, syncCloudNow } from './cloud-sync.ts'

export function cloudSettings(): void {
    onSettingsLoad(async () => {
        const form = document.querySelector<HTMLFormElement>('#cloud-form')
        const server = document.querySelector<HTMLInputElement>('#cloud-server')
        const name = document.querySelector<HTMLInputElement>('#cloud-device-name')
        const username = document.querySelector<HTMLInputElement>('#cloud-username')
        const password = document.querySelector<HTMLInputElement>('#cloud-password')
        const toggle = document.querySelector<HTMLButtonElement>('#cloud-register-mode')
        if (!form || !server || !name || !username || !password || !toggle) return
        const saved = (await storage.local.get('cloud')).cloud
        server.value = saved?.url ?? defaultAccountServer()
        username.value = saved?.username ?? ''
        server.addEventListener('invalid', () => {
            server.closest('details')!.open = true
        })
        name.value = saved?.name ?? (/Android|iPhone|iPad/.test(navigator.userAgent) ? '我的手机' : '我的电脑')
        updateConnected(saved)
        let registering = false
        const loadAccountConfig = async (): Promise<void> => {
            try {
                const config = await cloudJson<AccountConfig>({ url: server.value, token: '' }, 'auth/config')
                toggle.hidden = !config.registrationOpen && !(config.firstAccount && saved?.owner && !saved.accountId)
            } catch { /* Login can still be retried when the service is reachable. */ }
        }
        void loadAccountConfig()
        server.addEventListener('change', () => void loadAccountConfig())
        toggle.addEventListener('click', () => {
            registering = !registering
            toggle.textContent = registering ? '已有账号，登录' : '创建账号'
            document.getElementById('cloud-login-submit')!.textContent = registering ? '创建账号' : '登录'
            password.autocomplete = registering ? 'new-password' : 'current-password'
            password.minLength = registering ? 12 : 1
            password.placeholder = registering ? '至少 12 个字符' : ''
        })
        if (saved?.error) cloudStatus(saved.error, 'error')
        else if (saved) {
            cloudStatus(
                saved.lastSync
                    ? `已同步 · ${new Date(saved.lastSync).toLocaleString()}`
                    : '已连接，请选择要导入的内容。',
            )
        }
        let working = false
        const run = async (action: () => Promise<void>, backup = false): Promise<void> => {
            if (working) return
            working = true
            const activeForm = backup ? document.getElementById('cloud-backup-form')! : form
            const status = backup ? backupStatus : cloudStatus
            activeForm.setAttribute('aria-busy', 'true')
            const buttons = document.querySelectorAll<HTMLButtonElement>('#cloud-sync button, #cloud-backup button')
            buttons.forEach((button) => {
                button.disabled = true
            })
            try {
                await action()
            } catch (error) {
                status(error instanceof Error ? error.message : '操作失败，请重试。', 'error')
            } finally {
                buttons.forEach((button) => {
                    button.disabled = false
                })
                activeForm.setAttribute('aria-busy', 'false')
                working = false
                updateConnected((await storage.local.get('cloud')).cloud)
            }
        }
        const connection = async (): Promise<CloudConnection> => {
            const current = (await storage.local.get('cloud')).cloud
            if (!current?.accountId) throw new Error('请先登录。')
            return current
        }
        const on = (id: string, action: () => Promise<void>) =>
            document.getElementById(id)?.addEventListener('click', () => {
                void run(action, id.startsWith('cloud-backup'))
            })
        document.addEventListener('bonjourr-cloud-session-expired', (event) => {
            const { token } = (event as CustomEvent<{ token: string }>).detail
            void storage.local.get('cloud').then(({ cloud }) => {
                if (cloud?.token !== token) return
                updateConnected()
                location.reload()
            })
        })
        form.addEventListener('submit', (event) => {
            event.preventDefault()
            void run(async () => {
                await connectAccount(server.value, username.value, password.value, registering, name.value)
                password.value = ''
            })
        })
        on('cloud-sync-now', async () => {
            await syncCloudNow()
        })
        on('cloud-adopt', async () => {
            if (!confirm('采用云端内容替换本机的共享设置和快捷链接？本机布局会保留。尚未同步的本机修改将被放弃。')) {
                return
            }
            await adoptCloud()
        })
        on('cloud-initialize', async () => {
            if (!confirm('将本机的设置、快捷链接和媒体导入空白云端？请确认这是内容完整的设备。')) return
            await initializeCloud()
        })
        on('cloud-disconnect', async () => {
            const current = await connection()
            if (!confirm('退出当前账号？本机内容和未同步修改仍会保留。')) return
            try {
                await cloudFetch(current, 'auth/logout', { method: 'POST' })
            } finally {
                await storage.local.set({ cloud: { ...current, token: '', expiresAt: 0 }, syncType: 'off' })
                updateConnected()
                location.reload()
            }
        })
        on('cloud-devices-refresh', async () => {
            const current = await connection()
            const devices = await cloudJson<{ id: string; name: string; owner: number; revoked_at?: string }[]>(
                current,
                'devices',
            )
            const container = document.getElementById('cloud-devices')!
            container.replaceChildren()
            for (const device of devices.filter((item) => !item.revoked_at)) {
                const row = document.createElement('div')
                row.className = 'wrapper'
                const label = document.createElement('span')
                label.textContent = `${device.name}${device.id === current.deviceId ? '（此设备）' : ''}`
                row.append(label)
                if (device.id !== current.deviceId) {
                    const button = document.createElement('button')
                    button.className = 'param-btn'
                    button.type = 'button'
                    button.textContent = '撤销授权'
                    button.addEventListener('click', () => {
                        void run(async () => {
                            if (!confirm(`撤销“${device.name}”的访问权限？`)) return
                            await cloudFetch(current, `devices/${device.id}`, { method: 'DELETE' })
                            row.remove()
                        })
                    })
                    row.append(button)
                }
                container.append(row)
            }
        })
        let historyBefore: number | undefined
        const loadHistory = async (more = false): Promise<void> => {
            const current = await connection()
            const items = await cloudJson<
                {
                    id: number
                    key: string
                    json: string | null
                    deleted: number
                    revision: number
                    created_at: string
                    device_name?: string
                }[]
            >(current, `history${more && historyBefore ? `?before=${historyBefore}` : ''}`)
            const container = document.getElementById('cloud-history')!
            if (!more) container.replaceChildren()
            for (const item of items) {
                const row = document.createElement('div')
                row.className = 'cloud-history-row'
                const label = document.createElement('span')
                label.textContent = `${new Date(item.created_at).toLocaleString()} · ${
                    recordLabel(item.key, item.json)
                } · ${item.device_name ?? '设备'}`
                const button = document.createElement('button')
                button.className = 'param-btn'
                button.type = 'button'
                button.textContent = '恢复'
                button.addEventListener('click', () => {
                    void run(async () => {
                        if (
                            !confirm(
                                item.deleted
                                    ? '将这一项恢复到已删除状态？这可能移除最后一条快捷链接。'
                                    : '将这一项恢复到选定的历史版本？其他设置不会更改。',
                            )
                        ) return
                        const state = await cloudJson<CloudState>(current, 'state')
                        await cloudJson(current, 'history/restore', {
                            id: item.id,
                            baseRevision: state.records.find((record) => record.key === item.key)?.revision,
                            confirmClear: !!item.deleted,
                        })
                        await syncCloudNow()
                    })
                })
                row.append(label, button)
                container.append(row)
            }
            if (!items.length && !more) container.textContent = '暂无历史记录。'
            historyBefore = items.at(-1)?.id
            document.querySelector<HTMLButtonElement>('#cloud-history-more')!.hidden = items.length < 100
        }
        on('cloud-history-refresh', () => loadHistory())
        on('cloud-history-more', () => loadHistory(true))
        document.addEventListener('bonjourr-cloud-conflicts', (event) => {
            const { keys, local, remote } =
                (event as CustomEvent<{ keys: string[]; local: Record<string, string>; remote: CloudState }>).detail
            const container = document.getElementById('cloud-conflicts')!
            container.replaceChildren()
            for (const key of keys) {
                const row = document.createElement('label')
                row.className = 'cloud-history-row'
                const text = document.createElement('span')
                text.textContent = recordLabel(
                    key,
                    local[key] ?? remote.records.find((record) => record.key === key)?.json ?? null,
                )
                const select = document.createElement('select')
                select.dataset.key = key
                for (const [value, label] of [['', '选择保留内容'], ['local', '保留本机'], ['remote', '采用云端']]) {
                    const option = document.createElement('option')
                    option.value = value
                    option.textContent = label
                    select.append(option)
                }
                const detail = document.createElement('small')
                const remoteValue = remote.records.find((record) => record.key === key)?.json
                detail.textContent = `本机：${previewValue(key, local[key])}；云端：${previewValue(key, remoteValue)}`
                row.append(text, select, detail)
                container.append(row)
            }
        })
        on('cloud-resolve', async () => {
            const choices: Record<string, 'local' | 'remote'> = {}
            for (const select of document.querySelectorAll<HTMLSelectElement>('#cloud-conflicts select')) {
                if (select.value !== 'local' && select.value !== 'remote') {
                    throw new Error('请为每个冲突选择保留的内容。')
                }
                choices[select.dataset.key!] = select.value
            }
            await syncCloudNow({ resolutions: choices })
            document.getElementById('cloud-conflicts')?.replaceChildren()
        })
        on('cloud-confirm-clear', async () => {
            if (confirm('确认将本机的删除操作同步到云端，包括删除全部快捷链接？可通过历史记录恢复。')) {
                await syncCloudNow({ confirmClear: true })
            }
        })
        const passwordForm = document.querySelector<HTMLFormElement>('#cloud-password-form')!
        passwordForm.addEventListener('submit', (event) => {
            event.preventDefault()
            void run(async () => {
                const current = await connection()
                const profile = await cloudJson<Omit<CloudConnection, 'url'>>(
                    current,
                    'auth/password',
                    {
                        currentPassword: document.querySelector<HTMLInputElement>('#cloud-current-password')!.value,
                        password: document.querySelector<HTMLInputElement>('#cloud-new-password')!.value,
                    },
                )
                // Preserve the latest baseline if automatic sync ran while the request was in flight.
                const latest = await connection()
                if (latest.accountId !== current.accountId || latest.token !== current.token) {
                    throw new Error('账号连接已变化，请重新登录。')
                }
                await storage.local.set({ cloud: { ...latest, ...profile } })
                passwordForm.reset()
                cloudStatus('密码已更新，其他设备需重新登录。', 'success')
            })
        })
        const registration = document.querySelector<HTMLInputElement>('#cloud-registration-open')!
        if (saved?.admin) {
            try {
                const config = await cloudJson<AccountConfig>(saved, 'admin/registration')
                registration.checked = config.registrationOpen
                registration.disabled = false
            } catch { /* The saved page remains available offline. */ }
        }
        registration.addEventListener('change', () => {
            const allowed = registration.checked
            void run(async () => {
                try {
                    await cloudJson(await connection(), 'admin/registration', { registrationOpen: allowed }, 'PUT')
                    cloudStatus(allowed ? '已允许注册' : '已关闭注册', 'success')
                } catch (error) {
                    registration.checked = !allowed
                    throw error
                }
            })
        })
        const backupForm = document.querySelector<HTMLFormElement>('#cloud-backup-form')!
        backupForm.addEventListener('submit', (event) => {
            event.preventDefault()
            void run(async () => {
                const get = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!.value
                await cloudJson(await connection(), 'backup/config', {
                    url: get('cloud-backup-url'),
                    directory: get('cloud-backup-directory'),
                    username: get('cloud-backup-user'),
                    password: get('cloud-backup-password'),
                }, 'PUT')
                document.querySelector<HTMLInputElement>('#cloud-backup-password')!.value = ''
                backupStatus('自动备份已开启，每 6 小时一次。', 'success')
            }, true)
        })
        on('cloud-backup-import', async () => {
            const config = (await storage.local.get('webdav')).webdav
            if (!config) throw new Error('本机尚未配置 WebDAV，请先填写备份地址。')
            document.querySelector<HTMLInputElement>('#cloud-backup-url')!.value = config.url
            document.querySelector<HTMLInputElement>('#cloud-backup-directory')!.value = `${
                config.directory ?? 'Bonjourr'
            }/Cloud`
            document.querySelector<HTMLInputElement>('#cloud-backup-user')!.value = config.username
            document.querySelector<HTMLInputElement>('#cloud-backup-password')!.value = config.password
            backupStatus('已填入，保存后生效。')
        })
        on('cloud-backup-now', async () => {
            await cloudJson(await connection(), 'backups', {})
            backupStatus('备份已开始，可在“查看备份”中查看结果。', 'success')
        })
        on('cloud-backup-disable', async () => {
            if (!confirm('停止服务端自动备份？已生成的 WebDAV 文件仍会保留。')) return
            await cloudFetch(await connection(), 'backup/config', { method: 'DELETE' })
            backupStatus('已停止自动备份。', 'success')
        })
        on('cloud-backups-refresh', async () => {
            const current = await connection()
            const list = await cloudJson<{ id: string; created_at: string; status: string; error?: string }[]>(
                current,
                'backups',
            )
            const container = document.getElementById('cloud-backups')!
            container.replaceChildren()
            for (const backup of list) {
                const row = document.createElement('div')
                row.className = 'cloud-history-row'
                const label = document.createElement('span')
                const states: Record<string, string> = { running: '备份中', completed: '已完成', failed: '失败' }
                label.textContent = `${new Date(backup.created_at).toLocaleString()} · ${
                    states[backup.status] ?? backup.status
                }${backup.error ? ` · ${backup.error}` : ''}`
                row.append(label)
                if (backup.status === 'completed') {
                    const button = document.createElement('button')
                    button.className = 'param-btn'
                    button.type = 'button'
                    button.textContent = '恢复'
                    button.addEventListener('click', () => {
                        void run(async () => {
                            if (!confirm('将整个云端恢复到这份备份？所有已连接设备将同步这一版本。')) return
                            await cloudJson(current, 'backups/restore', { id: backup.id })
                            backupStatus('云端备份已恢复。若本机有未同步修改，请先处理冲突。', 'success')
                            await syncCloudNow()
                        }, true)
                    })
                    row.append(button)
                }
                container.append(row)
            }
            if (!list.length) container.textContent = '暂无备份'
        })
        on('cloud-backup-file-restore', async () => {
            const filename = document.querySelector<HTMLInputElement>('#cloud-backup-filename')!.value.trim()
            if (!/^bonjourr-[\w.-]+\.json$/.test(filename)) {
                throw new Error('请输入 WebDAV 中完整的 Bonjourr 云端备份文件名。')
            }
            if (!confirm('用这份 WebDAV 文件恢复整个云端？当前云端内容会被替换，并记录到修改历史。')) return
            await cloudJson(await connection(), 'backups/import', { filename })
            backupStatus('指定的云端备份已恢复，请采用云端内容或同步本机修改。', 'success')
        })
        if (saved?.owner) {
            try {
                const config = await cloudJson<
                    { configured: boolean; url?: string; directory?: string; username?: string }
                >(saved, 'backup/config')
                if (config.configured) {
                    document.querySelector<HTMLInputElement>('#cloud-backup-url')!.value = config.url ?? ''
                    document.querySelector<HTMLInputElement>('#cloud-backup-directory')!.value = config.directory ?? ''
                    document.querySelector<HTMLInputElement>('#cloud-backup-user')!.value = config.username ?? ''
                }
            } catch { /* A cached homepage remains usable while the server is offline. */ }
        }
    })
}

function updateConnected(connection?: CloudConnection): void {
    const connected = !!connection?.accountId && !!connection.token && !!connection.expiresAt &&
        connection.expiresAt > Date.now()
    const info = document.getElementById('cloud-connection-info')
    const name = document.getElementById('cloud-account-name')
    const description = document.getElementById('cloud-account-description')
    const state = document.getElementById('cloud-account-state')
    if (info) {
        info.title = connection ? new URL(connection.url).host : ''
        info.classList.toggle('is-connected', connected)
    }
    if (name) {
        name.textContent = connected ? `${connection.username}${connection.admin ? ' · 管理员' : ''}` : 'Bonjourr 云端'
    }
    if (description) {
        description.textContent = connected
            ? connection.lastSync
                ? `上次同步 ${new Date(connection.lastSync).toLocaleString()}`
                : '已连接，等待首次同步'
            : '登录后跨设备同步设置与快捷链接'
    }
    if (state) {
        state.textContent = connected ? '已连接' : '未登录'
    }
    document.querySelectorAll<HTMLElement>('[data-cloud-connected]').forEach((element) => {
        element.hidden = !connected
    })
    document.querySelectorAll<HTMLElement>('[data-cloud-owner]').forEach((element) => {
        element.hidden = !connected
    })
    document.querySelectorAll<HTMLElement>('[data-cloud-admin]').forEach((element) => {
        element.hidden = !connected || !connection?.admin
    })
    const fields = document.getElementById('cloud-account-fields')
    if (fields) fields.hidden = connected
    const ready = connected && !!connection?.baseline?.initialized
    const actions = document.getElementById('cloud-ready-actions')
    if (actions) actions.hidden = !ready
    const setup = document.querySelector<HTMLDetailsElement>('#cloud-setup')
    if (setup && setup.dataset.ready !== String(ready)) {
        setup.open = !ready
        setup.dataset.ready = String(ready)
    }
    const initialize = document.getElementById('cloud-initialize')
    if (initialize) initialize.hidden = !connected || ready
    const backupAccess = document.getElementById('cloud-backup-access')
    if (backupAccess) backupAccess.hidden = connected
    if (!connected) backupStatus('')
}

function backupStatus(message: string, state: 'pending' | 'success' | 'error' = 'pending'): void {
    const element = document.getElementById('cloud-backup-status')
    if (!element) return
    element.textContent = message
    element.dataset.state = state
}

function recordLabel(key: string, json: string | null): string {
    const parts = keyParts(key)
    try {
        const value = json ? JSON.parse(json) : null
        if (value?.title) return String(value.title)
    } catch { /* Fall back to the setting path. */ }
    const names: Record<string, string> = {
        sync: '设置',
        local: '本地资源配置',
        asset: '壁纸',
        icon: '图标',
        clock: '时钟',
        weather: '天气',
        linkgroups: '应用分组',
        searchbar: '搜索栏',
        backgrounds: '背景',
    }
    return parts.map((part) => names[part] ?? part).join(' / ')
}

function previewValue(key: string, json?: string | null): string {
    if (key.startsWith('local/weatherApiKey')) return json ? '已设置密钥' : '未设置'
    if (!json) return '已删除'
    try {
        const value = JSON.parse(json)
        return String(value?.title ?? (typeof value === 'string' ? value : json)).slice(0, 120)
    } catch {
        return '无法显示'
    }
}
