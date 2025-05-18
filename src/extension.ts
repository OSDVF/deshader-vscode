import * as vscode from 'vscode'
import { ProviderResult } from 'vscode'
import { DebugSession, deshaderSessions } from './debug/session'
import { DeshaderFilesystem } from './filesystem'
import { Communicator, ConnectionState, DeshaderScheme, DeshaderSchemes, DeshaderSchemesAndRaw, toRawURL, RunningShader, WebSocketContainer, WithColon } from './deshader'
import { deshaderTerminal, PROFILE } from './terminal'
import { deshaderLanguageClient } from './language'
import { unknownToString } from './format'
import { ConfigurationProvider } from './debug/config'
import { browseFile } from './RPC'
import Commands from './commands'
import { DeshaderRemoteResolver } from './remote'
import { UAParser } from 'ua-parser-js'
import path from 'path-browserify'
import { nodeOnly } from './macros'

const DEFAULT_CONNECTION = 'deshaderws://127.0.0.1:8082'

const SUPPORTS_REMOTE = 'registerRemoteAuthorityResolver' in vscode.workspace
let webNoticeShown = false
const parser = new UAParser(navigator.userAgent)
const parsedOS = parser.getOS().name

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Deshader')
	context.subscriptions.push(output)
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(e => {
		for (const editor of e) {
			if (editor.document.uri.path.startsWith('extension-output-osdvf.deshader')) {
				// TODO text decorations
			}
		}
	}))

	const comm = new Communicator(output)
	const fs = new DeshaderFilesystem(output, comm)
	let remoteFilesystemProvider: null | vscode.Disposable = null
	context.subscriptions.push(comm)
	if (SUPPORTS_REMOTE) {
		const resolver = new DeshaderRemoteResolver(comm)
		for (const s of DeshaderSchemes)
			context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(s, resolver))

		for (const f of vscode.workspace.workspaceFolders || []) {
			registerRemoteFileProvider(f)
		}
	}
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
		for (const a of e.added) {
			registerRemoteFileProvider(a)
			if(a.uri.scheme.startsWith('deshader') || a.uri.authority.startsWith('deshader')) {
				// check if we are already debugging on the Deshader side
				const commState = await comm.state({})
				if (commState.debugging && deshaderSessions.size == 0) {
					if(await vscode.window.showInformationMessage('Target program is already in debugging state. Do you want to attach a debug session to it?', 'Yes')) {
						vscode.debug.startDebugging(a, "Deshader Integrated")
					}
				}
			}
		}
		for (const r of e.removed) {
			if (remoteFilesystemProvider && r.uri.authority.startsWith('deshader')) {
				await callOrAwait(remoteFilesystemProvider.dispose)
				remoteFilesystemProvider = null
			}
		}
	}))
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DebugSession.TYPE, new InlineDebugAdapterFactory(comm, output)))
	if (parsedOS === 'Mac OS') {
		vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('deshader')) {
				const config = vscode.workspace.getConfiguration('deshader')
				const p = config.get<string>('path', '')
				if (p.endsWith('.app') || p.endsWith('.app/')) {
					if (await vscode.window.showInformationMessage('The path to the Deshader Library ends with .app. Do you want to set it to standard library location within the application bundle?', 'Yes', 'No') === 'Yes') {
						config.update('path', path.join(p, 'Contents/lib/libdeshader.dylib'))
					}
				}
			}
		})
	}

	const lspContainer = new WebSocketContainer()
	context.subscriptions.push(lspContainer)

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
			connectionStatusItem.tooltip = `Deshader connected (${comm.scheme}). Click to disconnect.`
			connectionStatusItem.command = Commands.disconnect
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
	let connPrompt: Promise<URL | null> | null = null

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
		vscode.commands.registerCommand(Commands.connect, (args) => {
			if (connPrompt) {
				return connPrompt
			}
			connPrompt = (async () => {
				const [input, force]: [string | undefined, boolean | undefined] = Array.isArray(args) ? args as any : [args, undefined]

				if (comm.isConnected && warnAlreadyConnected) {
					const response = await vscode.window.showWarningMessage('Deshader is already connected. Do you want to reconnect?', 'Yes', 'No', 'Never ask again')
					if (response === 'No') {
						return comm.endpointURL
					}
					if (response === 'Never ask again') {
						warnAlreadyConnected = false
					}
				}

				const response = input ? input : await askForConnectionString()
				if (response) {
					try {
						await deshaderConnect(response, undefined, force)
						return comm.endpointURL
					} catch (e) {
						vscode.window.showErrorMessage(`Failed to connect to Deshader (${comm.endpointURL}): ${unknownToString(e)}`)
					}
				}
				return null
			})()
			connPrompt.finally(() => connPrompt = null)
			return connPrompt
		}),
		vscode.commands.registerCommand(Commands.disconnect, () => {
			if (comm.isConnected) {
				comm.disconnect()
			}
			initialStatusItemState()
		}),
		vscode.commands.registerCommand(Commands.download, async () => {
			if (typeof deshader != 'undefined') {
				if (await vscode.window.showQuickPick(['Yes', 'No'], {
					ignoreFocusOut: true,
					title: 'Download Deshader?',
					placeHolder: 'This VSCode is already integrated with Deshader. Do you want to download it anyway?',
				}) != 'Yes') return
			}
			if (!process.env.DOWNLOAD_ENDPOINT && !process.env.GITHUB_ENDPOINT && !process.env.GITHUB_FALLBACK) {
				return vscode.window.showErrorMessage('The extension was built without a download endpoint')
			}
			let { os, arch, ext } = await getDeviceInfo()
			if (!os || !ext) {
				const selection = await vscode.window.showQuickPick<vscode.QuickPickItem & { arch?: boolean, os: typeof os, ext: typeof ext }>([{
					label: 'Arch Linux',
					os: 'linux',
					picked: os == 'linux',
					ext: 'tar.zst'
				}, {
					label: 'Debian-like Linux',
					os: 'linux',
					ext: 'deb'
				}, {
					label: 'Mac OS',
					arch: true,
					picked: os == 'macos',
					os: 'macos',
					ext: 'zip'
				}, {
					label: 'Windows',
					picked: os == 'windows',
					os: 'windows',
					ext: 'zip'
				}], { canPickMany: false, placeHolder: 'Select your OS' })
				if (!selection) return

				if (selection.arch || !ext) {
					const archSelection = (await vscode.window.showQuickPick<vscode.QuickPickItem & { arch: typeof arch }>([{
						label: 'x86_64',
						arch: '-x86_64',
						picked: arch == '-x86_64'
					}, {
						label: 'arm64',
						arch: '-arm64',
						picked: arch == '-arm64'
					}, {
						label: 'x86',
						arch: '-x86',
						picked: arch == '-x86'
					}], { canPickMany: false, placeHolder: 'Select your architecture' }))
					if (!archSelection) return
					arch = archSelection.arch
				}
				os = selection.os
				ext = selection.ext
			}

			let downloadEndpoint: string | undefined
			if (process.env.GITHUB_ENDPOINT) {
				try {
					const ghRelease = await fetch(`${process.env.GITHUB_ENDPOINT}/latest`)
					const ghReleaseJson = await ghRelease.json()
					if (ghReleaseJson.assets) {
						let includedArch: string | undefined
						let includedOSandExt: string | undefined
						for (const asset of ghReleaseJson.assets) {
							if (asset.name.includes(os) && asset.name.includes(ext)) {
								includedOSandExt = asset.browser_download_url
								if (asset.name.includes(arch)) {
									includedArch = asset.browser_download_url
									break
								}
							}
						}
						if (includedArch) {
							downloadEndpoint = includedArch
						} else if (includedOSandExt) {
							downloadEndpoint = includedOSandExt
						}
					}
				} catch (e) {
					console.error(e, 'Trying to download from the fallback endpoint')
				}
			}

			if (!downloadEndpoint) {
				try {
					downloadEndpoint = eval('`' + process.env.DOWNLOAD_ENDPOINT + '`')
				} catch (e) {
					console.error(e)
				}
			}
			if (downloadEndpoint) {
				if (vscode.env.appHost == 'desktop') {
					const dir = vscode.Uri.joinPath(context.globalStorageUri, "deshader-vscode_install")
					const downloadDir = dir.fsPath + '.tmp'
					const fs: typeof import('fs') = (await nodeOnly('fs') as typeof import('fs'))
					const Readable = (await nodeOnly('stream') as typeof import('stream')).Readable
					if (!fs.existsSync(downloadDir)) {
						fs.mkdirSync(downloadDir)
					}

					const file = await fetch(downloadEndpoint)
					const downloadedFile = path.join(downloadDir, path.basename(downloadEndpoint))
					const stream = fs.createWriteStream(downloadedFile)
					if (file.body) {
						await new Promise((resolve, reject) => {
							const w = Readable.fromWeb(file.body as any).pipe(stream)
							w.on('finish', resolve)
							w.on('error', reject)
						})
					}
					await vscode.window.showInformationMessage('Deshader downloaded. Now extract it and set the path to the library in the extension settings', 'Open')
					return await vscode.commands.executeCommand("revealFileInOS", downloadedFile)
				} else {
					try {
						let resp = await fetch(downloadEndpoint, { method: 'head', mode: 'no-cors' })
						if (resp.ok) {
							return await vscode.env.openExternal(vscode.Uri.parse(downloadEndpoint))
						}
					} catch (e) {
						console.error(e)
					}
				}
			}

			const opt = await vscode.window.showErrorMessage('Failed to download Deshader. Do you want to download it manually from ...?',
				...process.env.GITHUB_FALLBACK ? [{
					title: 'GitHub',
					url: vscode.Uri.parse(process.env.GITHUB_FALLBACK)
				}] : [], ...process.env.DOWNLOAD_ENDPOINT ? [{
					title: 'Deshader Web',
					url: vscode.Uri.parse(process.env.DOWNLOAD_ENDPOINT).with({ path: '' })
				}] : [])
			if (opt) {
				return await vscode.env.openExternal(opt.url)
			}
			return undefined
		}),
		vscode.commands.registerCommand(Commands.newTerminal, async () => {
			await comm.ensureConnected()
			if (comm.isConnected) { vscode.window.createTerminal(deshaderTerminal(comm)).show() }
		}),
		vscode.commands.registerCommand(Commands.addWorkspace, async () => {
			switch (comm.connectionState) {
				case ConnectionState.Connecting:
					await comm.ensureConnected()
					break

				case ConnectionState.Disconnected:
					await vscode.commands.executeCommand(Commands.connect)
					if (comm.connectionState == ConnectionState.Disconnected) {
						throw new Error('Not connected')
					}
					break
			}
			let anotherDeshader = false
			for (const f of vscode.workspace.workspaceFolders || []) {
				if (f.uri.scheme === comm.scheme) {
					if (f.uri.authority === comm.endpointURL?.host) {
						vscode.window.showInformationMessage('Shader workspace already open')
						return
					}
					anotherDeshader = true
				}
			}

			return vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, {
				uri: vscode.Uri.from({ scheme: comm.scheme!, authority: comm.endpointURL?.host, path: "/" }),
				name: anotherDeshader ? `Deshader ${comm.endpointURL!.hostname}` : "Deshader Virtual Workspace",
			})
		}),
		vscode.commands.registerCommand(Commands.connectLsp, async () => {
			await vscode.commands.executeCommand(Commands.connect)
			const opts: vscode.InputBoxOptions & vscode.QuickPickOptions = {
				title: "Remote langugage server", prompt: "Enter server URI", placeHolder: "ws://127.0.0.1:8083", canPickMany: false, ignoreFocusOut: true, validateInput(value) {
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
					vscode.window.showTextDocument(u.with({
						path: u.path + '.instrumented'
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
				const picked = await vscode.window.showQuickPick(["Single", "All"], { canPickMany: false, placeHolder: 'Select shader pause granularity mode', title: 'Pause Mode' })
				if (typeof picked !== 'undefined') {
					const single = picked == "Single"
					await sess.customRequest('pauseMode', { single })
					modeStatusItem.text = single ? '$(run)' : '$(run-all)'
				}
			} else {
				await notDebuggingMessage()
			}
		}),
		vscode.commands.registerCommand(Commands.window, () => {
			return openRemoteWindow(true)
		}),
		vscode.commands.registerCommand(Commands.newWindow, () => {
			return openRemoteWindow(false)
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
				if(!currentShader) {
					threadStatusItem.hide()
				}
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

	// Automatically connect if running inside deshader-integrated vscode
	if (typeof deshader !== 'undefined') {
		if (!deshader.commands && connPrompt == null) {
			// suggest default connection :)
			const url = toRawURL(DEFAULT_CONNECTION)
			const ws = new WebSocket(url.toString())
			await new Promise<void>((resolve) => {
				ws.onopen = async () => {
					ws.close()
					if (connPrompt != null) {
						await connPrompt.finally()
						if (comm.connectionState != ConnectionState.Disconnected) {
							resolve()
							return
						}
					}
					const response = await vscode.window.showInformationMessage('Deshader detected at the default connection (' + DEFAULT_CONNECTION + ')', 'Connect')
					if (response) {
						await deshaderConnect(DEFAULT_CONNECTION).finally()
					}
					resolve()
				}
				ws.onerror = resolve as any
			})
		}
		await deshaderConnect(deshader.commands, deshader.lsp).finally()
	}

	const languageClient = deshaderLanguageClient(lspContainer)
	context.subscriptions.push(languageClient)
	for (const s of DeshaderSchemes)
		context.subscriptions.push(vscode.workspace.registerFileSystemProvider(s, fs, { isCaseSensitive: true, isReadonly: false }))

	async function deshaderConnect(commURL?: string | URL | vscode.Uri, lspURL?: string | URL, openAfterConnect?: boolean) {
		try {
			if (commURL) {
				comm.endpointURL = commURL
			}
			if (lspURL) {
				lspContainer.endpoint = lspURL
			}
			const config = vscode.workspace.getConfiguration('deshader')
			if (commURL && (openAfterConnect ?? config.get<boolean>('openAfterConnect', true))) {
				vscode.commands.executeCommand(Commands.addWorkspace)
			}
		} catch (e) {
			output.appendLine(unknownToString(e))
			throw e
		}
	}

	function registerRemoteFileProvider(f: vscode.WorkspaceFolder) {
		if (!remoteFilesystemProvider && f.uri.scheme === 'vscode-remote' && f.uri.authority.startsWith('deshader')) {
			remoteFilesystemProvider = vscode.workspace.registerFileSystemProvider('vscode-remote', fs, { isCaseSensitive: true, isReadonly: false })
			context.subscriptions.push(remoteFilesystemProvider)
		}
	}
	async function openRemoteWindow(resuseWindow: boolean) {
		const input = await askForConnectionString()
		if (input) {
			const uri = vscode.Uri.parse(input)
			if (!DeshaderSchemes.includes(uri.scheme as DeshaderScheme)) {
				vscode.window.showErrorMessage('Only these schemes are supported: ' + DeshaderSchemes.join(', '))
			}
			const remoteUri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `${uri.scheme}+${uri.authority}`, path: "/" })
			const workspace = { uri: remoteUri, name: 'Deshader ' + uri.authority, index: 0 }
			registerRemoteFileProvider(workspace)
			if (vscode.env.appHost === 'web') {
				if (!webNoticeShown) vscode.window.showInformationMessage('Multiple windows are not supported')
				return vscode.workspace.updateWorkspaceFolders(0, 0, workspace)
			}
			else return vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `${uri.scheme}+${uri.authority}`, resuseWindow })
		}
		return undefined
	}
}

async function askForConnectionString() {
	return await vscode.window.showInputBox({
		placeHolder: 'Please enter the connection string',
		value: DEFAULT_CONNECTION,
		title: 'Connect to Deshader',
		ignoreFocusOut: true,
	})
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

async function getDeviceInfo() {
	let os: 'linux' | 'macos' | 'windows' | undefined
	let ext: `deb` | 'tar.zst' | 'zip' | undefined
	let arch: '-arm64' | '' | '-x86_64' | '-x86' = ''
	switch (parsedOS) {
		case 'Linux':
		case 'Chrome OS':
			os = 'linux'
			break
		case 'Mac OS':
			os = 'macos'
			ext = 'zip'
			const parsedArch = parser.getCPU().architecture
			switch (parsedArch) {
				case 'amd64':
				case 'ia64':
					arch = '-x86_64'
					break
				case 'arm':
				case 'arm64':
				case 'armhf':
					arch = '-arm64'
					break
				case 'ia32':
					arch = '-x86'
					break
			}
			break
	}
	if (parsedOS?.includes('Windows')) os = 'windows'
	if (!os) {
		os = await vscode.window.showQuickPick(['linux', 'macos', 'windows'], {
			ignoreFocusOut: true,
			title: 'Select OS',
			placeHolder: 'Select your OS'
		}) as any
		ext = 'zip'
	}
	return { os, ext, arch }
}

async function callOrAwait<T, U extends unknown[]>(f: () => T | Promise<T>, ...a: U): Promise<T> {
	const r = f()
	return r instanceof Promise ? r.then(r => r) : r
}