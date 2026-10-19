import { storage } from '../../storage.ts'
import { requestOrigin } from '../../shared/network.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { createBackup } from './backup.ts'
import { downloadWebdav, restoreWebdav, testWebdav, uploadWebdav, webdavDirectory, webdavFile } from './webdav.ts'
import type { Local, WebdavConfig } from '../../../types/local.ts'
import type { BackupPayload } from './backup.ts'

export function webdavSettings(local: Local): void {
    onSettingsLoad(() => {
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
        status.textContent = local.webdav?.lastSync
            ? `上次同步 ${new Date(local.webdav.lastSync).toLocaleString()}`
            : ''
        const controls = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#webdav-sync button'))
        const showStatus = (message: string, state: string): void => {
            status.textContent = message
            status.dataset.state = state
        }
        form.addEventListener('invalid', (event) => {
            const input = event.target as HTMLInputElement
            showStatus(
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
            busy = true
            controls().forEach((button) => {
                button.disabled = true
            })
            form.setAttribute('aria-busy', 'true')
            testButton.textContent = testing ? '正在连接…' : '保存'
            showStatus(testing ? '正在连接…' : '正在处理…', 'pending')
            try {
                const config: WebdavConfig = {
                    url: url.value.trim(),
                    directory: directory.value.trim(),
                    username: username.value.trim(),
                    password: password.value,
                }
                webdavFile(config)
                await requestOrigin(config.url)
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
                }
                await storage.local.set({ webdav: config })
                await action(config)
                status.dataset.state = 'success'
            } catch (error) {
                showStatus(
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
                    status.textContent = '已连接'
                },
                true,
            )
        })
        document.getElementById('webdav-upload')?.addEventListener('click', () => {
            void run(async (config) => {
                const backup = await createBackup()
                config.etag = await uploadWebdav(config, backup)
                config.lastSync = new Date().toISOString()
                await storage.local.set({ webdav: config })
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
                config.etag = result.etag
                config.lastSync = new Date().toISOString()
                await storage.local.set({ webdav: config })
                globalThis.location.reload()
            })
        })
    })
}
