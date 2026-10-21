await Deno.mkdir('.cloud', { recursive: true })
const values: Record<string, string> = {}
for (const [name, filename] of [['OWNER_KEY', 'owner-key'], ['BACKUP_KEY', 'backup-key']]) {
    const path = `.cloud/${filename}`
    let value: string
    try {
        value = (await Deno.readTextFile(path)).trim()
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error
        value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        await Deno.writeTextFile(path, value + '\n', { createNew: true, mode: 0o600 })
    }
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${filename} 格式无效，未覆盖现有密钥。`)
    values[name] = value
}
await Deno.writeTextFile('.cloud/secrets.json', JSON.stringify(values), { mode: 0o600 })
console.log('生产密钥已准备好，保存在被 Git 忽略的 .cloud 目录中。请单独备份它们。')
