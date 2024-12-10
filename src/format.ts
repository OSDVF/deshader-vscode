export function unknownToString(e: any, preferJson = false): string {
    if (typeof e == 'object') {
        if ('message' in e) {
            if (e instanceof Error) {
                return e.message + " at \n" + e.stack
            }
            return e.message
        } else if ('toString' in e && typeof e.toString == 'function') {
            if (preferJson) {
                return JSON.stringify(e)
            }
            return e.toString()
        }
    }
    return JSON.stringify(e)
}