import * as vscode from 'vscode'

export class ConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			config.type = 'deshader'
			config.stopOnEntry = true
			if (typeof deshader !== 'undefined' || typeof process != 'undefined') {
				config.name = 'Launch Program'
				config.request = 'launch'
				config.program = '${command:deshader.browseFile}'
			} else {
				config.name = 'Attach'
				config.request = 'attach'
			}
		}

		return config
	}
}