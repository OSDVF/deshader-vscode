// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { ProviderResult } from 'vscode'
import { DebugSession, deshaderSessions } from './debug/session'
import { DeshaderFilesystem } from './filesystem'
import { Communicator, RunningShader, WebSocketContainer } from './deshader'
import { deshaderTerminal } from './terminal'
import { deshaderLanguageClient } from './language'
import { unknownToString } from './format'
import { ConfigurationProvider } from './debug/config'
import { browseFile } from './RPC'

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Deshader')
	context.subscriptions.push(output)
	const comm = new Communicator(output)
	context.subscriptions.push(comm)
	const fs = vscode.workspace.registerFileSystemProvider('deshader', new DeshaderFilesystem(output, comm), { isCaseSensitive: true, isReadonly: false })
	context.subscriptions.push(fs)
	const debug = vscode.debug.registerDebugAdapterDescriptorFactory('deshader', new InlineDebugAdapterFactory(comm, output))
	context.subscriptions.push(debug)
	const lspContainer = new WebSocketContainer()
	context.subscriptions.push(lspContainer)
	const languageClient = deshaderLanguageClient(lspContainer)
	context.subscriptions.push(languageClient)

	async function notDebuggingMessage() {
		vscode.window.showErrorMessage("Deshader debugging session isn't currently active")
	}

	const threadStatusItem = vscode.window.createStatusBarItem('selectedThread', vscode.StatusBarAlignment.Left, 900)
	threadStatusItem.name = 'Shader Thread'
	threadStatusItem.tooltip = 'Select different shader thread'
	threadStatusItem.command = 'deshader.selectThread'
	async function updateStatus(session?: vscode.DebugSession) {
		if (typeof session !== 'undefined' && session.type == 'deshader') {
			modeStatusItem.text = await session.customRequest('getPauseMode') ? '$(run)' : '$(run-all)'
			modeStatusItem.show()
			threadStatusItem.show()
		} else {
			modeStatusItem.hide()
			threadStatusItem.hide()
		}
	}
	const modeStatusItem = vscode.window.createStatusBarItem('pauseMode', vscode.StatusBarAlignment.Left, 850)
	modeStatusItem.command = 'deshader.pauseMode'
	modeStatusItem.name = 'Shader Pause Mode'
	modeStatusItem.tooltip = 'Select shader pause granularity mode'

	const connectionStatusItem = vscode.window.createStatusBarItem('deshader', vscode.StatusBarAlignment.Left, 1000)
	connectionStatusItem.name = 'Deshader'
	function initialStatusItemState() {
		connectionStatusItem.text = '$(plug) Deshader'
		connectionStatusItem.command = 'deshader.connect'
		connectionStatusItem.tooltip = 'Click to connect to Deshader'
		connectionStatusItem.show()
	}
	initialStatusItemState()
	comm.onConnected.add(async () => {
		const u = comm.endpointURL
		if (u) {
			connectionStatusItem.text = "$(extension-deshader) " + u.host
			connectionStatusItem.tooltip = `Deshader connected (${u.protocol.substring(0, u.protocol.length - 1)}). Click to disconnect.`
			connectionStatusItem.command = 'deshader.disconnect'

			// check if we are already debugging on the Deshader side
			const commState = await comm.state({})
			if (commState.debugging && deshaderSessions.size == 0) {
				vscode.debug.startDebugging(undefined, "Deshader Integrated")
			}
		}
	})

	comm.onDisconnected.add(initialStatusItemState)

	let warnAlreadyConnected = true

	// Register disposables
	context.subscriptions.push(
		connectionStatusItem,
		vscode.commands.registerCommand('deshader.askForProgramName', () => vscode.window.showInputBox({
			placeHolder: 'Please enter the path of an executable file relative to the workspace root',
			value: 'a.out'
		})),
		vscode.commands.registerCommand('deshader.browseFile', () => typeof deshader !== 'undefined' ? browseFile() : vscode.window.showOpenDialog({
			title: 'Select Executable Program'
		}).then(uris => uris?.[0].fsPath)),
		vscode.commands.registerCommand('deshader.connect', async () => {
			if (comm.isConnected && warnAlreadyConnected) {
				const response = await vscode.window.showWarningMessage('Deshader is already connected. Do you want to reconnect?', 'Yes', 'No', 'Never ask again')
				if (response === 'No') {
					return
				}
				if (response === 'Never ask again') {
					warnAlreadyConnected = false
				}
			}

			const response = await vscode.window.showInputBox({
				placeHolder: 'Please enter the connection string',
				value: 'ws://127.0.0.1:8082'
			})
			if (response) {
				try {
					await deshaderConnect(response)
				} catch (e) {
					vscode.window.showErrorMessage(`Failed to connect to Deshader (${comm.endpointURL}): ${unknownToString(e)}`)
				}
			} else {
				vscode.window.showErrorMessage('No connection string provided')
			}
		}),
		vscode.commands.registerCommand('deshader.disconnect', () => {
			if (comm.isConnected) {
				comm.disconnect()
			}
			initialStatusItemState()
		}),
		vscode.commands.registerCommand('deshader.newTerminal', async () => {
			await comm.ensureConnected()
			if (comm.isConnected) { vscode.window.createTerminal(deshaderTerminal(comm)).show() }
		}),
		vscode.commands.registerCommand('deshader.openWorkspace', async () => {
			await vscode.commands.executeCommand('deshader.connect')
			comm.ensureConnected()
			vscode.commands.executeCommand('vscode.openFolder', { uri: vscode.Uri.from({ scheme: DeshaderFilesystem.scheme, path: "/" }), forceReuseWindow: true })
		}),
		vscode.commands.registerCommand('deshader.connectLsp', async () => {
			await vscode.commands.executeCommand('deshader.connect')
			const opts: vscode.InputBoxOptions & vscode.QuickPickOptions = {
				title: "Remote langugage server", prompt: "Enter server URI", placeHolder: "ws://127.0.0.1:8083", canPickMany: false, validateInput(value) {
					try {
						vscode.Uri.parse(value)
					} catch (e) {
						if (typeof e === 'object' && e != null && 'toString' in e) {
							return e.toString()
						}
						if (typeof e === 'string') { return e }
					}
					return undefined
				},
			}
			const suggest = lspContainer.endpoint.toString()
			const endpoint = await (suggest ? vscode.window.showQuickPick([suggest!], opts) : vscode.window.showInputBox(opts))
			if (typeof endpoint !== 'undefined') {
				try {
					lspContainer.endpoint = endpoint// TODO: indicate connected LSP
				} catch (e) {
					vscode.window.showErrorMessage("Invalid URI: " + e)
				}
			}
		}),
		vscode.commands.registerCommand('deshader.selectThread', async () => {
			const sess = vscode.debug.activeDebugSession
			if (sess?.type === 'deshader') {
				const current = await sess?.customRequest('getCurrentShader') as RunningShader
				let stringThread = current.selectedThread.join(',')
				let newThread = await vscode.window.showInputBox({
					value: stringThread,
					placeHolder: stringThread,
					prompt: 'Enter the thread identifier x,?y,?z',
					title: 'Select shader thread',
				})
				newThread ??= stringThread
				const thread = newThread.trim().split(',').map((x) => parseInt(x))
				let group: number[] = []
				let isNewGroup = false
				if (current.selectedGroup) {
					let stringGroup = current.selectedGroup.join(',')
					let newGroup = await vscode.window.showInputBox({
						value: stringGroup,
						placeHolder: stringGroup,
						prompt: 'Enter the group identifier x,?y,?z',
						title: 'Select shader thread group',
					})
					newGroup ??= stringGroup
					newGroup = newGroup.trim()
					group = newGroup.split(',').map((x) => parseInt(x))
					isNewGroup = newGroup !== stringGroup
				}
				if (newThread.trim() === stringThread && !isNewGroup) {
					vscode.window.showInformationMessage('No changes made to the thread selection')
					return
				}

				await sess.customRequest('selectThread', { group, thread })
			} else {
				await notDebuggingMessage()
			}
		}),
		vscode.commands.registerCommand('deshader.showInstrumented', async () => {
			const sess = vscode.debug.activeDebugSession
			if (sess?.type === 'deshader') {
				const e = vscode.window.activeTextEditor
				if (e && !e.document.uri.path.endsWith('.instrumented')) {
					const u = e.document.uri
					const deshaderPath = u.scheme === DeshaderFilesystem.scheme ? u.path : await comm.translatePath({ path: u.path })
					vscode.workspace.openTextDocument(u.with({
						scheme: DeshaderFilesystem.scheme,
						path: deshaderPath + '.instrumented'
					}))
				} else {
					vscode.window.showErrorMessage('No active text editor')
				}
			} else {
				await notDebuggingMessage()
			}
		}),
		vscode.commands.registerCommand('deshader.pauseMode', async () => {
			const sess = vscode.debug.activeDebugSession
			if (sess?.type === 'deshader') {
				const picked = await vscode.window.showQuickPick(["Single", "All"], { canPickMany: false })
				if (typeof picked !== 'undefined') {
					const single = picked == "Single"
					await sess.customRequest('pauseMode', { single })
					modeStatusItem.text = single ? '$(run)' : '$(run-all)'
				}
			} else {
				await notDebuggingMessage()
			}
		}),
		vscode.window.registerTerminalProfileProvider('deshader.terminal', {
			async provideTerminalProfile(token: vscode.CancellationToken): Promise<vscode.TerminalProfile> {
				await comm.ensureConnected()
				return new vscode.TerminalProfile(deshaderTerminal(comm))
			}
		} as vscode.TerminalProfileProvider),
		vscode.debug.onDidStartDebugSession(updateStatus),
		vscode.debug.onDidChangeActiveDebugSession(updateStatus),
		vscode.debug.onDidTerminateDebugSession((e) => {
			if (e.type == 'deshader') {
				modeStatusItem.hide()
				threadStatusItem.hide()
			}
		}),
		vscode.debug.registerDebugConfigurationProvider('deshader', new ConfigurationProvider())
	)
	// Update the current shader ref when the active debug session selected thread changes
	if (typeof vscode.debug.onDidChangeActiveStackItem !== 'undefined') {
		context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(async (e) => {
			if (typeof e !== 'undefined' && e.session.type === 'deshader') {
				e.session.customRequest('updateStackItem', e)
				threadStatusItem.show()
				const currentShader = await e.session.customRequest('getCurrentShader') as RunningShader
				if (currentShader.selectedGroup) {
					threadStatusItem.text = `$(pulse) (${currentShader.selectedGroup.join(',')})(${currentShader.selectedThread.join(',')})`
				} else {
					threadStatusItem.text = `$(pulse) (${currentShader.selectedThread.join(',')})`
				}
				threadStatusItem.hide()
			} else {
				threadStatusItem.hide()
			}
		}))
	}

	async function deshaderConnect(commURL?: string | URL | vscode.Uri, lspURL?: string | URL) {
		try {
			if (commURL) {
				comm.endpointURL = commURL
			}
			if (lspURL) {
				lspContainer.endpoint = lspURL
			}
		} catch (e) {
			output.appendLine(unknownToString(e))
			throw e
		}
	}

	// Automatically connect if running inside deshader-integrated vscode
	if (typeof deshader !== 'undefined') {
		deshaderConnect(deshader.commands, deshader.lsp)
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	comm: Communicator
	outputChannel: vscode.OutputChannel | null
	constructor(comm: Communicator, outputChannel: vscode.OutputChannel | null = null) {
		this.comm = comm
		this.outputChannel = outputChannel
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		// since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
		return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession(this.comm, this.outputChannel) as any as vscode.DebugAdapter)
	}
}