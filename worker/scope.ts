export interface AccountEnv extends CloudflareEnv {
    accountId: string
}

export function accountEnv(env: CloudflareEnv, accountId: string): AccountEnv {
    if (!/^(legacy|[a-f0-9-]{36})$/.test(accountId)) throw new Error('Invalid account namespace')
    const prefix = accountId === 'legacy' ? '' : `users/${accountId}/`
    const media = prefix
        ? new Proxy(env.MEDIA, {
            get(target, property): unknown {
                const value = Reflect.get(target, property)
                if (['get', 'head', 'put'].includes(String(property))) {
                    return (key: string, ...args: unknown[]) => Reflect.apply(value, target, [prefix + key, ...args])
                }
                if (typeof value === 'function') throw new Error('Unsupported account media operation')
                return value
            },
        })
        : env.MEDIA
    return { ...env, MEDIA: media, accountId }
}
