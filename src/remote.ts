import * as vscode from 'vscode'
import { Communicator, ConnectionState, type DeshaderOrRawScheme, DeshaderSchemesAndRaw } from './deshader'
import Commands from './commands'

export class DeshaderRemoteResolver implements vscode.RemoteAuthorityResolver {
    comm: Communicator
    constructor(comm: Communicator) {
        this.comm = comm
    }

    async resolve(authority: string): Promise<vscode.ResolverResult> {
        const [type, dest] = authority.split('+')
        if (DeshaderSchemesAndRaw.includes(type as DeshaderOrRawScheme)) {
            let url = this.comm.endpointURL
            if (this.comm.connectionState !== ConnectionState.Connected || url === null || url.host !== dest) {
                url = await vscode.commands.executeCommand(Commands.connect, dest)
            }
            return new vscode.ResolvedAuthority(url!.hostname, parseInt(url!.port) ?? 8082)
        }
        throw new Error(`Authority ${type} not implemented.`)
    }
}