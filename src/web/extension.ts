// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { DebugSession } from '../debug/session';
import { DeshaderFilesystem } from '../filesystem';
import { Communicator, Config, RunningShader } from '../deshader';
import { State } from '../state';
import { deshaderTerminal } from '../terminal';
import { deshaderLanguageClient } from '../language';

export function activate(context: vscode.ExtensionContext) {
	let state: State | null = null;
	let lspPort: number | null = null;

	async function notConnectedMessage() {
		if (await vscode.window.showErrorMessage("Deshader not connected", { modal: true }, "Connect")) {
			await vscode.commands.executeCommand('deshader.connect');
		}
	}
	async function notDebuggingMessage() {
		vscode.window.showErrorMessage("Deshader debugging session isn't currently active");
	}

	async function ensureConnected() {
		if (state == null) {
			await notConnectedMessage();
		}
		if (state != null) {
			await state.comm.ensureConnected();
		}
	}
	const threadStatusItem = vscode.window.createStatusBarItem('selectedThread', vscode.StatusBarAlignment.Left, 900);
	threadStatusItem.name = 'Shader Thread';
	threadStatusItem.tooltip = 'Select different shader thread';
	threadStatusItem.command = 'deshader.selectThread';
	async function updateStatus(session?: vscode.DebugSession) {
		if (typeof session !== 'undefined' && session.type == 'deshader') {
			modeStatusItem.text = await session.customRequest('getPauseMode') ? '$(run)' : '$(run-all)';
			modeStatusItem.show();
			threadStatusItem.show();
		} else {
			modeStatusItem.hide();
			threadStatusItem.hide();
		}
	}
	const modeStatusItem = vscode.window.createStatusBarItem('pauseMode', vscode.StatusBarAlignment.Left, 850);
	modeStatusItem.command = 'deshader.pauseMode';
	modeStatusItem.name = 'Shader Pause Mode';
	modeStatusItem.tooltip = 'Select shader pause granularity mode';

	const connectionStatusItem = vscode.window.createStatusBarItem('deshader', vscode.StatusBarAlignment.Left, 1000);
	connectionStatusItem.name = 'Deshader';
	function initialStatusItemState() {
		connectionStatusItem.text = '$(plug) Deshader';
		connectionStatusItem.command = 'deshader.connect';
		connectionStatusItem.tooltip = 'Click to connect to Deshader';
		connectionStatusItem.show();
	}
	initialStatusItemState();

	// Register disposables
	context.subscriptions.push(
		connectionStatusItem,
		vscode.commands.registerCommand('deshader.askForProgramName', () => vscode.window.showInputBox({
			placeHolder: 'Please enter the path of an executable file relative to the workspace root',
			value: 'a.out'
		})),
		vscode.commands.registerCommand('deshader.connect', async () => {
			await deshaderConnect(await vscode.window.showInputBox({
				placeHolder: 'Please enter the connection string',
				value: 'ws://localhost:8082'
			}));
			if (state) {
				state.comm.connected.catch(() => {
					vscode.window.showErrorMessage(`Failed to connect to Deshader (${state?.comm.uri})`);
					vscode.commands.executeCommand('deshader.disconnect');
				});
			}
		}),
		vscode.commands.registerCommand('deshader.disconnect', () => {
			if (state != null) {
				state.comm.disconnect();
				state.debug.dispose();
				state.fs.dispose();
				state.languageClient?.dispose();
			}
			state = null;
			initialStatusItemState();
		}),
		vscode.commands.registerCommand('deshader.newTerminal', async () => {
			await ensureConnected();
			if (state != null)
				{vscode.window.createTerminal(deshaderTerminal(state.comm)).show();}
		}),
		vscode.commands.registerCommand('deshader.openWorkspace', async () => {
			if (state == null) {
				await vscode.commands.executeCommand('deshader.connect');
			}
			if (state != null) {
				state.comm.ensureConnected();
				vscode.commands.executeCommand('vscode.openFolder', { uri: vscode.Uri.from({ scheme: DeshaderFilesystem.scheme, path: "/" }), forceReuseWindow: true });
			}
		}),
		vscode.commands.registerCommand('deshader.connectLsp', async () => {
			var suggest: string | null = null;
			if (state == null) {
				await vscode.commands.executeCommand('deshader.connect');
			}
			if (state != null && lspPort) {
				suggest = state.comm.getHost() + lspPort;
			}
			const opts: vscode.InputBoxOptions & vscode.QuickPickOptions = {
				title: "Remote langugage server", prompt: "Enter server URI", placeHolder: "ws://localhost:8083", canPickMany: false, validateInput(value) {
					try {
						vscode.Uri.parse(value);
					} catch (e) {
						if (typeof e === 'object' && e != null && 'toString' in e) {
							return e.toString();
						}
						if (typeof e === 'string')
							{return e;}
					}
					return undefined;
				},
			};
			const endpoint = await (suggest ? vscode.window.showQuickPick([suggest!], opts) : vscode.window.showInputBox(opts));
			if (typeof endpoint !== 'undefined') {
				const cl = deshaderLanguageClient(endpoint);
				if (state) {
					state.languageClient = cl;
				}
				context.subscriptions.push(cl);
			}
		}),
		vscode.commands.registerCommand('deshader.selectThread', async () => {
			const sess = vscode.debug.activeDebugSession;
			if (sess?.type === 'deshader') {
				const current = await sess?.customRequest('getCurrentShader') as RunningShader;
				let stringThread = current.selectedThread.join(',');
				let newThread = await vscode.window.showInputBox({
					value: stringThread,
					placeHolder: stringThread,
					prompt: 'Enter the thread identifier x,?y,?z',
					title: 'Select shader thread',
				});
				newThread ??= stringThread;
				const thread = newThread.trim().split(',').map((x) => parseInt(x));
				let group: number[] = [];
				let isNewGroup = false;
				if (current.selectedGroup) {
					let stringGroup = current.selectedGroup.join(',');
					let newGroup = await vscode.window.showInputBox({
						value: stringGroup,
						placeHolder: stringGroup,
						prompt: 'Enter the group identifier x,?y,?z',
						title: 'Select shader thread group',
					});
					newGroup ??= stringGroup;
					newGroup = newGroup.trim();
					group = newGroup.split(',').map((x) => parseInt(x));
					isNewGroup = newGroup !== stringGroup;
				}
				if (newThread.trim() === stringThread && !isNewGroup) {
					vscode.window.showInformationMessage('No changes made to the thread selection');
					return;
				}

				await sess.customRequest('selectThread', { group, thread });
			} else {
				await notDebuggingMessage();
			}
		}),
		vscode.commands.registerCommand('deshader.pauseMode', async () => {
			const sess = vscode.debug.activeDebugSession;
			if (sess?.type === 'deshader') {
				const picked = await vscode.window.showQuickPick(["Single", "All"], { canPickMany: false });
				if (typeof picked !== 'undefined') {
					const single = picked == "Single";
					await sess.customRequest('pauseMode', { single });
					modeStatusItem.text = single ? '$(run)' : '$(run-all)';
				}
			} else {
				await notDebuggingMessage();
			}
		}),
		vscode.window.registerTerminalProfileProvider('deshader.terminal', {
			async provideTerminalProfile(token: vscode.CancellationToken): Promise<vscode.TerminalProfile> {
				await ensureConnected();
				if (state == null)
					{throw Error("Deshader connection failed");}
				return new vscode.TerminalProfile(deshaderTerminal(state.comm));
			}
		} as vscode.TerminalProfileProvider),
		vscode.debug.onDidStartDebugSession(updateStatus),
		vscode.debug.onDidChangeActiveDebugSession(updateStatus),
		vscode.debug.onDidTerminateDebugSession((e) => {
			if (e.type == 'deshader') {
				modeStatusItem.hide();
				threadStatusItem.hide();
			}
		})
	);
	// Update the current shader ref when the active debug session selected thread changes
	if (typeof vscode.debug.onDidChangeActiveStackItem !== 'undefined')
		{context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(async (e) => {
			if (typeof e !== 'undefined' && e.session.type === 'deshader') {
				e.session.customRequest('updateStackItem', e);
				threadStatusItem.show();
				const currentShader = await e.session.customRequest('getCurrentShader') as RunningShader;
				if (currentShader.selectedGroup) {
					threadStatusItem.text = `$(pulse) (${currentShader.selectedGroup.join(',')})(${currentShader.selectedThread.join(',')})`;
				} else {
					threadStatusItem.text = `$(pulse) (${currentShader.selectedThread.join(',')})`;
				}
				threadStatusItem.hide();
			} else {
				threadStatusItem.hide();
			}
		}));}

	const output = vscode.window.createOutputChannel('Deshader');
	context.subscriptions.push(output);
	async function deshaderConnect(uri?: string, config?: Config) {
		try {
			if (state != null) {
				state.comm.disconnect();
				state.fs.dispose();
				state.languageClient?.dispose();
			}
			const comm = typeof uri !== 'undefined' ? Communicator.fromUri(vscode.Uri.parse(uri), output) : Communicator.fromConfig(config!, output);
			state = {
				comm,
				fs: vscode.workspace.registerFileSystemProvider('deshader', new DeshaderFilesystem(output, comm), { isCaseSensitive: true, isReadonly: false }),
				debug: vscode.debug.registerDebugAdapterDescriptorFactory('deshader', new InlineDebugAdapterFactory(comm, output)),
				languageClient: lspPort == null ? null : deshaderLanguageClient(`ws://${comm.getHost()}:${lspPort}/`,)
			};
			context.subscriptions.push(state.fs, state.comm, state.debug);
			if (state.languageClient) {context.subscriptions.push(state.languageClient);}

			connectionStatusItem.text = "$(extension-deshader) " + comm.uri.authority;
			connectionStatusItem.tooltip = `Deshader connected (${comm.uri.scheme}). Click to disconnect.`;
			connectionStatusItem.command = 'deshader.disconnect';

			// check if we are already debugging on the Deshader side
			await comm.ensureConnected();
			const commState = await comm.state({});
			if (commState.debugging) {
				vscode.debug.startDebugging(undefined, "Deshader Integrated");
			}
			lspPort = commState.lsp || null;

		} catch (e) {
			if ('message' in (e as Error))
				{output.appendLine((e as Error).message);}
			else
				{output.appendLine(JSON.stringify(e));}

			vscode.commands.executeCommand('deshader.disconnect');
		}
	}

	// Automatically connect if running inside deshader-integrated vscode
	if (typeof deshader !== 'undefined') {
		let protocol: Config['protocol'] = 'http';
		if (typeof deshader.wss !== 'undefined') {
			protocol = 'wss';
		} else if (typeof deshader.https !== 'undefined') {
			protocol = 'https';
		} else if (typeof deshader.ws !== 'undefined') {
			protocol = 'ws';
		}

		lspPort = deshader.lsp.port;
		deshaderConnect(undefined, { protocol, ...deshader[protocol] });
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	comm: Communicator | null;
	outputChannel: vscode.OutputChannel | null;
	constructor(comm: Communicator | null, outputChannel: vscode.OutputChannel | null = null) {
		this.comm = comm;
		this.outputChannel = outputChannel;
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		// since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
		return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession(this.comm, this.outputChannel) as any as vscode.DebugAdapter);
	}
}