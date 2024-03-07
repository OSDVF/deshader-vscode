// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { ProviderResult } from 'vscode'
import { DebugSession } from './debugSession'
import { DeshaderFilesystem } from './filesystemProvider'
import { Communicator, Config } from './deshader'

// compile-time selection of debug adapter run mode
const runMode: 'server' | 'inline' = 'inline'

// cleanup inconsitent line breaks
const formatText = (text: string) => `\r${text.split(/(\r?\n)/g).join("\r")}\r`

export function activate(context: vscode.ExtensionContext) {
	let nextTerminalId = 1
	console.log('Activated Deshader Extension')

	context.subscriptions.push(vscode.commands.registerCommand('deshader.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: 'Please enter the relative path of an executable file in the workspace folder',
			value: 'a.out'
		})
	}))

	const output = vscode.window.createOutputChannel('Deshader')
	let comm: Communicator | null = null
	function connectToFS(uri?: string, config?: Config) {
		try {
			comm ??= typeof uri !== 'undefined' ? Communicator.fromUri(vscode.Uri.parse(uri), output) : Communicator.fromConfig(config!, output)
			const fs = new DeshaderFilesystem(output, comm)
			context.subscriptions.push(vscode.workspace.registerFileSystemProvider('deshader', fs, { isCaseSensitive: true, isReadonly: false }))
		} catch (e) {
			if ('message' in (e as Error))
				output.appendLine((e as Error).message)
			else
				output.appendLine(JSON.stringify(e))
		}
	}

	if (typeof deshader !== 'undefined') {// Automatically connect if running inside deshader-embedded vscode
		console.log("Found embedded Deshader config ", deshader)
		let protocol: Config['protocol'] = 'http'
		if (typeof deshader.wss !== 'undefined') {
			protocol = 'wss'
		} else if (typeof deshader.https !== 'undefined') {
			protocol = 'https'
		} else if (typeof deshader.ws !== 'undefined') {
			protocol = 'ws'
		}
		connectToFS(undefined, { protocol, ...deshader[protocol] })
	}

	const writeEmitter = new vscode.EventEmitter<string>()
	function terminal(): vscode.ExtensionTerminalOptions {
		const keys = {
			enter: "\r",
			backspace: "\x7f",
			delete: "\x1b[3~",
			right: "\x1b[C",
		}
		const actions = {
			cursorBack: "\x1b[D",
			deleteAll: "\x1b[0K",
			deleteChar: "\x1b[P",
			clear: "\x1b[2J\x1b[3J\x1b[;H",
		}
		function defaultLine() {
			return `dsh${comm?.uri.toString() ?? ' (not connected)'}$ `
		}
		let input = ""
		let cursor = 0
		return {
			name: `Deshader Terminal ${nextTerminalId++}`,
			pty: {
				onDidWrite: writeEmitter.event,
				open() {
					if (comm == null) {
						writeEmitter.fire(formatText("Deshader not connected. Connect by launching a debug configuration or opening embedded Deshader Editor."))
					}
					else {
						writeEmitter.fire(defaultLine())
					}
				},
				close() { },
				async handleInput(char) {
					switch (char) {
						case keys.enter:
							if (comm != null) {
								writeEmitter.fire(`\r${defaultLine()}${input}\r\n`)
								// třrim off leading default prompt
								try {
									// run the command
									const response = await comm.send(input)
									writeEmitter.fire(`\r${formatText(response)}`)
								} catch (error) {
									writeEmitter.fire(`\r${formatText((error as Error).message)}\n`)
								}
							} else {
								writeEmitter.fire(`\r${formatText("Not connected")}\n`)
							}
							writeEmitter.fire(defaultLine())
							input = ""
							cursor = 0
							break
						case keys.backspace:
							if (input.length <= 0) {
								return
							}
							// remove last character TODO not last
							input = input.slice(0, cursor - 1) + input.slice(cursor)
							cursor--
							writeEmitter.fire(actions.cursorBack)
							writeEmitter.fire(actions.deleteChar)
							return
						case keys.right:
							if (cursor >= input.length) {
								return
							}
							cursor++
							writeEmitter.fire(char)
							return
						case actions.cursorBack:
							if (cursor <= 0) {
								return
							}
							cursor--
							writeEmitter.fire(char)
							return
						case keys.delete:
							input =
								input.slice(0, cursor) +
								input.slice(cursor + 1)
							writeEmitter.fire(actions.deleteChar)
							break
						default:
							// typing a new character
							input += char
							cursor++
							writeEmitter.fire(char)
					}
				},
			},
		}
	}
	context.subscriptions.push(vscode.window.registerTerminalProfileProvider('deshader.terminal', {
		provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.ExtensionTerminalOptions> {
			return terminal()
		}
	} as vscode.TerminalProfileProvider))

	context.subscriptions.push(vscode.commands.registerCommand('deshader.newTerminal', () => {
		vscode.window.createTerminal(terminal()).show()
	}))

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicating via a socket
			factory = require('./descriptorFactory').default
			break

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new InlineDebugAdapterFactory(comm)
			break
	}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('deshader', factory))
	if ('dispose' in factory) {
		context.subscriptions.push(factory as vscode.Disposable)
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	comm: Communicator | null
	constructor(comm: Communicator | null) {
		this.comm = comm
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		// since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
		return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession(this.comm) as vscode.DebugAdapter)
	}
}