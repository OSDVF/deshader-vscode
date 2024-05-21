import type { Communicator } from './deshader'
import type { BaseLanguageClient } from 'vscode-languageclient'
import type * as vscode from 'vscode'

export type State = {
    comm: Communicator,
    fs: vscode.Disposable,
    debug: vscode.Disposable,
    languageClient: BaseLanguageClient | null
}