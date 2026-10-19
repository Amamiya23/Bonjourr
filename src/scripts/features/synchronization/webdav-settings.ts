import { storage } from '../../storage.ts'
import { requestOrigin } from '../../shared/network.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { createBackup, parseBackup, recoveryBackup, restoreBackup, saveRecoveryBackup } from './backup.ts'
import { downloadWebdav, testWebdav, uploadWebdav, webdavDirectory, webdavFile } from './webdav.ts'
import type { Local, WebdavConfig } from '../../../types/local.ts'
import type { Backup } from './backup.ts'

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
            ? `上次传输：${new Date(local.webdav.lastSync).toLocaleString()}`
            : '尚未连接 WebDAV。'
        const controls = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#webdav-sync button'))
        const showStatus = (message: string, state: string): void => {
            status.textContent = message
            status.dataset.state = state
        }
        form.addEventListener('invalid', (event) => {
            const input = event.target as HTMLInputElement
            showStatus(
                input === url ? '请填写有效的 WebDAV HTTP(S) 服务地址后再测试。' : input.validationMessage,
                'error',
            )
        }, true)
        let busy = false
        const run = async (
            action: (config: WebdavConfig) => Promise<void>,
            remote = true,
            testing = false,
        ): Promise<void> => {
            if (busy) return
            busy = true
            controls().forEach((button) => {
                button.disabled = true
            })
            form.setAttribute('aria-busy', 'true')
            testButton.textContent = testing ? '正在测试…' : '保存并测试连接'
            showStatus(testing ? '正在测试连接并检查备份目录，请稍候…' : '正在处理…', 'pending')
            try {
                const config: WebdavConfig = {
                    url: url.value.trim(),
                    directory: directory.value.trim(),
                    username: username.value.trim(),
                    password: password.value,
                }
                if (remote) {
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
                }
                await action(config)
                status.dataset.state = 'success'
            } catch (error) {
                showStatus(
                    `${testing ? '连接测试失败：' : ''}${error instanceof Error ? error.message : '操作失败。'}`,
                    'error',
                )
            } finally {
                busy = false
                form.setAttribute('aria-busy', 'false')
                testButton.textContent = '保存并测试连接'
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
                    status.textContent = `连接成功，配置已保存。备份目录：${webdavDirectory(config).pathname}`
                },
                true,
                true,
            )
        })
        document.getElementById('webdav-upload')?.addEventListener('click', () => {
            void run(async (config) => {
                const backup = await createBackup()
                config.etag = await uploadWebdav(config, backup)
                config.lastSync = new Date().toISOString()
                await storage.local.set({ webdav: config })
                status.textContent = '上传完成，已同步设置、应用、本地壁纸与自定义图标。'
            })
        })
        document.getElementById('webdav-snapshot')?.addEventListener('click', () => {
            void run(async (config) => {
                await uploadWebdav(config, await createBackup(), true)
                status.textContent = '已另存带时间戳的完整快照，原有备份未被覆盖。'
            })
        })
        const restore = async (backup: Backup): Promise<boolean> => {
            const applications = Object.values(backup.settings).filter((item) =>
                item && typeof item === 'object' && '_id' in item
            ).length
            const date = new Date(backup.createdAt).toLocaleString()
            if (
                !globalThis.confirm(
                    `恢复 ${date} 的备份？包含 ${applications} 个应用/文件夹和 ${
                        Object.keys(backup.local.backgroundFiles).length
                    } 个本地背景。当前数据会先保存为本地恢复副本。`,
                )
            ) {
                status.textContent = '已取消恢复。'
                return false
            }
            await saveRecoveryBackup()
            await restoreBackup(backup)
            return true
        }
        document.getElementById('webdav-download')?.addEventListener('click', () => {
            void run(async (config) => {
                const result = await downloadWebdav(config)
                if (!await restore(result.backup)) return
                config.etag = result.etag
                config.lastSync = new Date().toISOString()
                await storage.local.set({ webdav: config })
                globalThis.location.reload()
            })
        })
        document.getElementById('webdav-recover')?.addEventListener('click', () => {
            void run(async () => {
                const backup = await recoveryBackup()
                if (!globalThis.confirm('恢复上次下载或导入之前的本地数据？')) {
                    status.textContent = '已取消恢复。'
                    return
                }
                await restoreBackup(backup)
                globalThis.location.reload()
            }, false)
        })
        document.getElementById('webdav-export')?.addEventListener('click', () => {
            void run(async () => {
                const backup = await createBackup()
                const href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }))
                const anchor = document.createElement('a')
                anchor.href = href
                anchor.download = `bonjourr-full-${backup.createdAt.replace(/[:.]/g, '-')}.json`
                anchor.click()
                setTimeout(() => URL.revokeObjectURL(href), 1000)
                status.textContent = '完整备份已导出，不含天气密钥或同步凭据。'
            }, false)
        })
        const input = document.querySelector<HTMLInputElement>('#webdav-import-file')
        document.getElementById('webdav-import')?.addEventListener('click', () => input?.click())
        input?.addEventListener('change', () => {
            void run(async () => {
                const file = input.files?.[0]
                if (!file) return
                if (file.size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB。')
                const backup = parseBackup(await file.text())
                if (await restore(backup)) globalThis.location.reload()
            }, false).finally(() => {
                input.value = ''
            })
        })
    })
}
