// Run only for an existing personal instance, using its private recovery key.
const server = Deno.args[0] ?? 'https://bonjourr.telyra.top'
const configResponse = await fetch(new URL('/api/auth/config', server))
if (!configResponse.ok) throw new Error(`无法检查账号状态（HTTP ${configResponse.status}）。`)
const config: { firstAccount: boolean } = await configResponse.json()
if (!config.firstAccount) {
    console.log('管理员账号已经存在，未更改任何账号或密码。')
    Deno.exit(0)
}
const owner = (await Deno.readTextFile('.cloud/owner-key')).trim()
let account: { username: string; password: string; server: string }
try {
    account = JSON.parse(await Deno.readTextFile('.cloud/initial-admin.json'))
} catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    account = {
        server,
        username: 'admin',
        password: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    }
    await Deno.writeTextFile('.cloud/initial-admin.json', JSON.stringify(account), { mode: 0o600, createNew: true })
}
const response = await fetch(new URL('/api/auth/register', server), {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...account, name: '部署初始化' }),
    redirect: 'error',
})
if (!response.ok) throw new Error(`无法建立管理员（HTTP ${response.status}）。凭据文件已保留，请勿删除后重试。`)
const session: { token: string } = await response.json()
await Deno.writeTextFile(
    '.cloud/initial-admin.txt',
    `网址：${server}\n用户名：${account.username}\n密码：${account.password}\n\n登录后可在设置中修改密码。请妥善保管此文件。\n`,
    { mode: 0o600 },
)
const logout = await fetch(new URL('/api/auth/logout', server), {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    redirect: 'error',
})
await logout.body?.cancel()
console.log('首个管理员已建立，原云端内容保留。登录凭据已写入 .cloud/initial-admin.txt。')
