import { storage } from '../../storage.ts'
import { requestOrigin } from '../../shared/network.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { createBackup, webdavFingerprint } from './backup.ts'
import {
    downloadWebdav,
    hasStrongWebdavEtag,
    restoreWebdav,
    testWebdav,
    uploadWebdav,
    webdavDirectory,
    WebdavError,
    webdavFile,
} from './webdav.ts'
import { saveWebdavSync, showWebdavStatus, withWebdavLock } from './webdav-auto.ts'
import type { Local, WebdavConfig } from '../../../types/local.ts'
import type { BackupPayload } from './backup.ts'

export function webdavSettings(local: Local): void {
    onSettingsLoad(async () => {
        local.webdav = (await storage.local.get('webdav')).webdav
        const form = document.querySelector<HTMLFormElement>('#webdav-form')
        const url = document.querySelector<HTMLInputElement>('#webdav-url')
        const directory = document.querySelector<HTMLInputElement>('#webdav-directory')
        const username = document.querySelector<HTMLInputElement>('#webdav-username')
        const password = document.querySelector<HTMLInputElement>('#webdav-password')
        const status = document.getElementById('webdav-status')
        const testButton = document.querySelector<HTMLButtonElement>('#webdav-test')
        if (!form || !url || !directory || !username || !password || !status || !testButton) return
        url.value = local.webdav?.url ?? ''
        directory.value = local.webdav ? local.webdav.directory ?? '' : 'Bonjourr'
        // Old versions stored the complete backup path in URL. Keep using that exact location.
        if (local.webdav && local.webdav.directory === undefined) {
            try {
                const previousUrl = new URL(local.webdav.url)
                if (/\/Bonjourr\/?$/.test(previousUrl.pathname)) {
                    previousUrl.pathname = previousUrl.pathname.replace(/Bonjourr\/?$/, '')
                    url.value = previousUrl.href
                    directory.value = 'Bonjourr'
                }
            } catch {
                // Leave invalid saved addresses editable so that the next test can explain the error.
            }
        }
        username.value = local.webdav?.username ?? ''
        password.value = local.webdav?.password ?? ''
        status.textContent = local.webdav?.error ||
            (local.webdav?.lastSync ? `上次备份操作 ${new Date(local.webdav.lastSync).toLocaleString()}` : '')
        if (local.webdav?.error) status.dataset.state = 'error'
        const controls = () =>
            Array.from(
                document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
                    '#webdav-sync input, #webdav-sync button',
                ),
            )
        form.addEventListener('invalid', (event) => {
            const input = event.target as HTMLInputElement
            showWebdavStatus(
                input === url ? '地址无效。' : input.validationMessage,
                'error',
            )
        }, true)
        let busy = false
        const run = async (
            action: (config: WebdavConfig) => Promise<void>,
            testing = false,
        ): Promise<void> => {
            if (busy) return
            if (!form.reportValidity()) return
            busy = true
            controls().forEach((button) => {
                button.disabled = true
            })
            form.setAttribute('aria-busy', 'true')
            testButton.textContent = testing ? '正在连接…' : '保存'
            showWebdavStatus(testing ? '正在连接…' : '正在处理…', 'pending')
            try {
                const config: WebdavConfig = {
                    url: url.value.trim(),
                    directory: directory.value.trim(),
                    username: username.value.trim(),
                    password: password.value,
                    autoSync: false,
                }
                webdavFile(config)
                await requestOrigin(config.url)
                await withWebdavLock(async () => {
                    const previous = (await storage.local.get('webdav')).webdav
                    let sameDirectory = false
                    try {
                        sameDirectory = !!previous && webdavDirectory(previous).href === webdavDirectory(config).href
                    } catch {
                        // A corrected configuration must not be blocked by an invalid saved address.
                    }
                    if (
                        previous && sameDirectory && previous.username === config.username &&
                        previous.password === config.password
                    ) {
                        config.etag = previous.etag
                        config.lastSync = previous.lastSync
                        config.fingerprint = previous.fingerprint
                    }
                    await action(config)
                })
                status.dataset.state = 'success'
            } catch (error) {
                showWebdavStatus(
                    error instanceof Error ? error.message : '操作失败。',
                    'error',
                )
            } finally {
                busy = false
                form.setAttribute('aria-busy', 'false')
                testButton.textContent = '保存'
                controls().forEach((button) => {
                    button.disabled = false
                })
            }
        }
        form.addEventListener('submit', (event) => {
            event.preventDefault()
            void run(
                async (config) => {
                    await testWebdav(config)
                    await storage.local.set({ webdav: config })
                    status.textContent = '已连接'
                },
                true,
            )
        })
        document.getElementById('webdav-upload')?.addEventListener('click', () => {
            void run(async (config) => {
                // Explicitly resolve a conflict only after observing the remote revision.
                const fingerprint = await webdavFingerprint()
                let previousBackup: BackupPayload | undefined
                let allowOverwrite = false
                try {
                    const remote = await downloadWebdav(config)
                    previousBackup = remote.backup
                    if (!hasStrongWebdavEtag(remote.etag)) {
                        if (
                            !globalThis.confirm(
                                '服务器未提供版本标记，无法检测其他设备的并发修改。仍要用本地设置覆盖远程备份？',
                            )
                        ) {
                            status.textContent = '已取消备份。'
                            return
                        }
                        allowOverwrite = true
                    } else if (remote.etag !== config.etag || !config.fingerprint) {
                        if (!globalThis.confirm('远程已有备份。保留本地设置并覆盖远程备份？')) {
                            status.textContent = '已取消备份。'
                            return
                        }
                    }
                    config.etag = allowOverwrite ? undefined : remote.etag
                } catch (error) {
                    if (!(error instanceof WebdavError) || error.status !== 404) throw error
                    config.etag = undefined
                }
                const backup = await createBackup()
                if (await webdavFingerprint() !== fingerprint) throw new Error('本地设置已变化，请重新备份。')
                const etag = await uploadWebdav(config, backup, previousBackup, allowOverwrite)
                await saveWebdavSync(config, fingerprint, etag)
                status.textContent = '备份完成'
            })
        })
        const restore = async (backup: BackupPayload, config: WebdavConfig): Promise<boolean> => {
            const date = new Date(backup.createdAt).toLocaleString()
            if (!globalThis.confirm(`恢复 ${date} 的备份？`)) {
                status.textContent = '已取消恢复。'
                return false
            }
            await restoreWebdav(config, backup)
            return true
        }
        document.getElementById('webdav-download')?.addEventListener('click', () => {
            void run(async (config) => {
                const result = await downloadWebdav(config)
                if (!await restore(result.backup, config)) return
                await saveWebdavSync(config, await webdavFingerprint(), result.etag)
                globalThis.location.reload()
            })
        })
    })
}
