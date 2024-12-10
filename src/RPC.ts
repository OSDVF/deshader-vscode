async function deshaderRPC(name: string, args: Record<string, any>) {
    if (typeof deshader == 'undefined') {
        throw new Error('Deshader context is not available')
    }
    const req = await fetch(`${location.origin}/${name}?${Object.keys(args)
        .filter(k => (typeof args[k] != 'undefined'))
        .map(k => `${k}=${JSON.stringify(args[k])}`).join('&')}`)
    if (!req.ok) {
        throw new Error(`RPC request failed: ${req.statusText}, ${await req.text()}`)
    }
    return req.json()
}

// Bindings:

/**
* NOTE: Only available in Deshader Editor context
* @param argv Program name and arguments
* @param directory Absolute path to the desired working directory
* @param env Environment variables map
* @returns Process ID
*/
export async function run(argv: string[], directory?: string, env?: { [key: string]: string }): Promise<number> {
    return deshaderRPC('run', { argv, directory, env })
}
export async function browseFile(current?: string): Promise<string> {
    return deshaderRPC('browseFile', { current })
}
export async function browseDirectory(current?: string): Promise<string> {
    return deshaderRPC('browseDirectory', { current })
}
/**
 * Terminate the running subprocess
 */
export async function terminate(): Promise<void> {
    return deshaderRPC('terminate', {})
}
export async function isRunning(): Promise<boolean> {
    return deshaderRPC('isRunning', {})
}