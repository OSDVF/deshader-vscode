import * as vscode from 'vscode';
import { type DeshaderOrRawScheme, DeshaderSchemesAndRaw } from './deshader';
import Commands from './commands'

export class DeshaderRemoteResolver implements vscode.RemoteAuthorityResolver {

    async resolve(authority: string): Promise<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (DeshaderSchemesAndRaw.includes(type as DeshaderOrRawScheme)) {
            const url: URL = await vscode.commands.executeCommand(Commands.connect, dest)
            return new vscode.ResolvedAuthority(url.hostname, parseInt(url.port) ?? 8082);
        }
        throw new Error(`Authority ${type} not implemented.`)
    }
}