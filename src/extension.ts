// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { ProviderResult } from 'vscode'
import { DebugSession, deshaderSessions } from './debug/session'
import { DeshaderFilesystem } from './filesystem'
import { Communicator, ConnectionState, DeshaderScheme, DeshaderSchemes, DeshaderSchemesAndRaw, RunningShader, WebSocketContainer } from './deshader'
import { deshaderTerminal, PROFILE } from './terminal'
import { deshaderLanguageClient } from './language'
import { unknownToString } from './format'
import { ConfigurationProvider } from './debug/config'
import { browseFile } from './RPC'
import Commands from './commands'
import { DeshaderRemoteResolver } from './remote'

const DEFAULT_CONNECTION = 'ws://127.0.0.1:8082'

const SUPPORTS_REMOTE = 'registerRemoteAuthorityResolver' in vscode.workspace
export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Deshader')
	const comm = new Communicator(output)
	const fs = new DeshaderFilesystem(output, comm)
	for (const s of DeshaderSchemes)
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider(s, fs, { isCaseSensitive: true, isReadonly: false }))
	context.subscriptions.push(output)
	context.subscriptions.push(comm)
	if (SUPPORTS_REMOTE) {
		const resolver = new DeshaderRemoteResolver()
		context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(DeshaderSchemes[0], resolver))
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DebugSession.TYPE, new InlineDebugAdapterFactory(comm, output)))

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
	threadStatusItem.command = Commands.selectThread
	async function updateStatus(session?: vscode.DebugSession) {
		if (typeof session !== 'undefined' && session.type == DebugSession.TYPE) {
			modeStatusItem.text = await session.customRequest('getPauseMode') ? '$(run)' : '$(run-all)'
			modeStatusItem.show()
			threadStatusItem.show()
		} else {
			modeStatusItem.hide()
			threadStatusItem.hide()
		}
	}
	const modeStatusItem = vscode.window.createStatusBarItem('pauseMode', vscode.StatusBarAlignment.Left, 850)
	modeStatusItem.command = Commands.pauseMode
	modeStatusItem.name = 'Shader Pause Mode'
	modeStatusItem.tooltip = 'Select shader pause granularity mode'

	const connectionStatusItem = vscode.window.createStatusBarItem('deshader', vscode.StatusBarAlignment.Left, 1000)
	connectionStatusItem.name = 'Deshader'
	function initialStatusItemState() {
		vscode.commands.executeCommand('setContext', 'deshader.connected', false)

		connectionStatusItem.text = '$(plug) Deshader'
		connectionStatusItem.command = Commands.connect
		connectionStatusItem.tooltip = 'Click to connect to Deshader'
		connectionStatusItem.show()
	}
	initialStatusItemState()
	comm.onConnected.add(async () => {
		vscode.commands.executeCommand('setContext', 'deshader.connected', true)
		const u = comm.endpointURL
		if (u) {
			connectionStatusItem.text = "$(extension-deshader) " + u.host
			connectionStatusItem.tooltip = `Deshader connected (${u.protocol.substring(0, u.protocol.length - 1)}). Click to disconnect.`
			connectionStatusItem.command = Commands.disconnect

			// check if we are already debugging on the Deshader side
			const commState = await comm.state({})
			if (commState.debugging && deshaderSessions.size == 0) {
				vscode.debug.startDebugging(undefined, "Deshader Integrated")
			}
		}
	})

	comm.onDisconnected.add(initialStatusItemState)
	comm.onDisconnected.add(() => {
		for (const s of deshaderSessions) {
			vscode.debug.stopDebugging(s)// TODO find the correct session
		}
		for (const w of vscode.workspace.workspaceFolders || []) {
			if (DeshaderSchemesAndRaw.includes(w.uri.scheme as DeshaderScheme)) {
				vscode.workspace.updateWorkspaceFolders(w.index, 1)
			}
		}
	})

	let warnAlreadyConnected = true

	// Register disposables
	context.subscriptions.push(
		connectionStatusItem,
		vscode.commands.registerCommand(Commands.askForProgramName, () => vscode.window.showInputBox({
			placeHolder: 'Please enter the path of an executable file relative to the workspace root',
			value: 'a.out'
		})),
		vscode.commands.registerCommand(Commands.browseFile, () => typeof deshader !== 'undefined' ? browseFile() : vscode.window.showOpenDialog({
			title: 'Select Executable Program'
		}).then(uris => uris?.[0].fsPath)),
		vscode.commands.registerCommand(Commands.connect, async (args) => {
			const input: string | undefined = typeof args === 'string' ? args : undefined
			if (comm.isConnected && warnAlreadyConnected) {
				const response = await vscode.window.showWarningMessage('Deshader is already connected. Do you want to reconnect?', 'Yes', 'No', 'Never ask again')
				if (response === 'No') {
					return comm.endpointURL
				}
				if (response === 'Never ask again') {
					warnAlreadyConnected = false
				}
			}

			const response = input ? input : await vscode.window.showInputBox({
				placeHolder: 'Please enter the connection string',
				value: DEFAULT_CONNECTION
			})
			if (response) {
				try {
					await deshaderConnect(response)
					return comm.endpointURL
				} catch (e) {
					vscode.window.showErrorMessage(`Failed to connect to Deshader (${comm.endpointURL}): ${unknownToString(e)}`)
				}
			}
			return null
		}),
		vscode.commands.registerCommand(Commands.disconnect, () => {
			if (comm.isConnected) {
				comm.disconnect()
			}
			initialStatusItemState()
		}),
		vscode.commands.registerCommand(Commands.newTerminal, async () => {
			await comm.ensureConnected()
			if (comm.isConnected) { vscode.window.createTerminal(deshaderTerminal(comm)).show() }
		}),
		vscode.commands.registerCommand(Commands.openWorkspace, async () => {
			if (comm.connectionState == ConnectionState.Disconnected) {
				await vscode.commands.executeCommand(Commands.connect)
				if (comm.connectionState == ConnectionState.Disconnected) {
					throw new Error('Not connected')
				}
			}
			for (const f of vscode.workspace.workspaceFolders || []) {
				if (f.uri.scheme === comm.scheme && f.uri.authority === comm.endpointURL?.host) {
					vscode.window.showInformationMessage('Shader workspace already open')
					return
				}
			}
			return vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri: vscode.Uri.from({ scheme: comm.scheme!, authority: comm.endpointURL?.host, path: "/" }) })
		}),
		vscode.commands.registerCommand(Commands.connectLsp, async () => {
			await vscode.commands.executeCommand(Commands.connect)
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
		vscode.commands.registerCommand(Commands.selectThread, async () => {
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
		vscode.commands.registerCommand(Commands.showInstrumented, async () => {
			const sess = vscode.debug.activeDebugSession
			if (sess?.type === DebugSession.TYPE) {
				const e = vscode.window.activeTextEditor
				if (e && !e.document.uri.path.endsWith('.instrumented')) {
					const u = e.document.uri
					const deshaderPath = DeshaderSchemesAndRaw.includes(u.scheme as DeshaderScheme) ? u.path : await comm.translatePath({ path: u.path })
					vscode.workspace.openTextDocument(u.with({
						scheme: u.scheme,
						path: deshaderPath + '.instrumented'
					}))
				} else {
					vscode.window.showErrorMessage('No active text editor')
				}
			} else {
				await notDebuggingMessage()
			}
		}),
		vscode.commands.registerCommand(Commands.pauseMode, async () => {
			const sess = vscode.debug.activeDebugSession
			if (sess?.type === DebugSession.TYPE) {
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
		vscode.window.registerTerminalProfileProvider(PROFILE, {
			async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
				await comm.ensureConnected()
				return new vscode.TerminalProfile(deshaderTerminal(comm))
			}
		} as vscode.TerminalProfileProvider),
		vscode.debug.onDidStartDebugSession(updateStatus),
		vscode.debug.onDidChangeActiveDebugSession(updateStatus),
		vscode.debug.onDidTerminateDebugSession((e) => {
			if (e.type == DebugSession.TYPE) {
				modeStatusItem.hide()
				threadStatusItem.hide()
			}
		}),
		vscode.debug.registerDebugConfigurationProvider(DebugSession.TYPE, new ConfigurationProvider())
	)
	// Update the current shader ref when the active debug session selected thread changes
	if (typeof vscode.debug.onDidChangeActiveStackItem !== 'undefined') {
		context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(async (e) => {
			if (typeof e !== 'undefined' && e.session.type === DebugSession.TYPE) {
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
			const config = vscode.workspace.getConfiguration('deshader')
			if (config.get<boolean>('openAfterConnect', true)) {
				vscode.commands.executeCommand(Commands.openWorkspace)
			}
		} catch (e) {
			output.appendLine(unknownToString(e))
			throw e
		}
	}

	// Automatically connect if running inside deshader-integrated vscode
	if (typeof deshader !== 'undefined') {
		if (!deshader.commands) {
			// suggest default connection :)
			const ws = new WebSocket(DEFAULT_CONNECTION)
			ws.onopen = async () => {
				ws.close()
				const response = await vscode.window.showInformationMessage('Deshader detected at the default connection (' + DEFAULT_CONNECTION + ')', 'Connect')
				if (response) {
					deshaderConnect(DEFAULT_CONNECTION)
				}
			}
		}
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