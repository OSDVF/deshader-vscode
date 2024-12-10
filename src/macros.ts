export function nodeOnly(module: string) {
    return typeof process != 'undefined' ? import(module) : null
}