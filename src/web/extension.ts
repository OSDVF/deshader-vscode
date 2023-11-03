// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { DebugSession } from './debugSession';
import { DeshaderFilesystem } from './filesystemProvider';

// compile-time selection of debug adapter run mode
const runMode: 'external' | 'server' | 'inline' = 'inline';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "deshader-vscode" is now active in the web extension host!');

	context.subscriptions.push(vscode.commands.registerCommand('deshader.helloWorld', () => {
		return vscode.window.showInformationMessage('Hello World from Deshader integration for VSCode in a web extension host!');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('deshader.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: 'Please enter the relative path of an executable file in the workspace folder',
			value: 'a.out'
		});
	}));

	const fs = new DeshaderFilesystem();
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('deshader', fs, { isCaseSensitive: true, isReadonly: false }));


	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicating via a socket
			factory = require('./descriptorFactory').default;
			break;

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new InlineDebugAdapterFactory();
			break;

		case 'external': default:
			// run the debug adapter as a separate process
			factory = new DebugAdapterExecutableFactory();
			break;
	}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('deshader', factory))
	if ('dispose' in factory) {
		context.subscriptions.push(factory as vscode.Disposable);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {

	// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
	// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.

	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
		// param "executable" contains the executable optionally specified in the package.json (if any)

		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
		if (!executable) {
			console.error('No debug adapter executable specified in package.json');
		}

		// make VS Code launch the DA executable
		return executable;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		// since DebugAdapterInlineImplementation is proposed API, a cast to <any> is required for now
		return <any>new vscode.DebugAdapterInlineImplementation(new DebugSession());
	}
}